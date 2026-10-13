import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import * as database from '../db/pool.js';
import { resolveUser, HttpError } from '../lib/users.js';
import { refuseForReviewDemo } from '../lib/review-demo.js';
import { sealText, openValue } from '../lib/field-crypto.js';
import { minimePost, minimeConfigured } from '../services/minime.js';
import { detectFileRequests } from '../services/file-requests.js';

export const fileActionsRouter = Router();
const { queryOne, query } = database;
const withTransaction = work => database.withTransaction(work);
fileActionsRouter.use('/:id/file-actions', async (req, res, next) => {
  await resolveUser(req);
  if (process.env.MINIME_FILE_ACTIONS !== '1') {
    if (req.method === 'GET') return res.json({ available: false, actions: [] });
    throw new HttpError(503, 'file_actions_unavailable');
  }
  next();
});
const hash = text => createHash('sha256').update(text).digest('hex');
const decode = row => ({ ...row, payload: JSON.parse(openValue(row.payload)) });
const receipt = row => {
  const { payload, ...rest } = decode(row);
  const { approval_hash, ...publicPayload } = payload;
  return { id: rest.id, call_id: rest.call_id, version: rest.version, status: rest.status,
    message_id: rest.message_id, error_code: rest.error_code, ...publicPayload };
};
const sealed = (row, payload) => sealText(JSON.stringify(payload), { userId: row.user_id, rowId: row.id, field: 'file_actions:payload' });
async function callFor(req) {
  const user = await resolveUser(req);
  const call = await queryOne('SELECT * FROM calls WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [req.params.id, user.id]);
  if (!call) throw new HttpError(404, 'call_not_found');
  return { user, call };
}
async function actionFor(req) {
  const { user, call } = await callFor(req);
  const action = await queryOne('SELECT * FROM file_actions WHERE id=$1 AND call_id=$2 AND user_id=$3', [req.params.action, call.id, user.id]);
  if (!action) throw new HttpError(404, 'action_not_found');
  return { user, call, action, payload: decode(action).payload };
}
async function connected(user) {
  refuseForReviewDemo(user);
  if (!minimeConfigured() || !await queryOne('SELECT user_id FROM minime_links WHERE user_id=$1', [user.id])) {
    throw new HttpError(409, 'minime_not_linked', 'Connect MiniMe in Settings first.');
  }
}
async function remote(user, operation, data) {
  try { return await minimePost({ ...data, user_id: user.id, operation }, { path: '/api/dimts/files' }); }
  catch (e) { throw new HttpError(e.status === 409 ? 409 : 503, 'minime_file_action_unavailable',
    e.status === 409 ? 'The file, recipient or connection changed. Review the action again.' : 'MiniMe is unavailable. Try again.'); }
}
const rowsFor = (call, user) => query('SELECT * FROM file_actions WHERE call_id=$1 AND user_id=$2 ORDER BY source_index', [call.id, user.id]);
fileActionsRouter.get('/:id/file-actions', async (req, res) => {
  const { call, user } = await callFor(req);
  res.json({ available: true, actions: (await rowsFor(call, user)).rows.map(receipt) });
});
fileActionsRouter.post('/:id/file-actions/prepare', async (req, res) => {
  const { call, user } = await callFor(req);
  await connected(user);
  if (call.status !== 'ready' || !call.transcript || call.voicemail) throw new HttpError(409, 'call_not_ready');
  const existing = await rowsFor(call, user);
  if (existing.rows.length) return res.json({ actions: existing.rows.map(receipt) });
  const candidates = await detectFileRequests(call.transcript);
  await withTransaction(async tx => {
    const { rows: [current] } = await tx.query('SELECT * FROM calls WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [call.id, user.id]);
    if (!current || hash(current.transcript || '') !== hash(call.transcript)) throw new HttpError(409, 'source_changed');
    const { rows: already } = await tx.query('SELECT id FROM file_actions WHERE call_id=$1', [call.id]);
    if (already.length) return;
    for (const [index, payload] of candidates.entries()) {
      const row = { id: randomUUID(), user_id: user.id };
      await tx.query(`INSERT INTO file_actions(id,user_id,call_id,source_hash,source_index,payload)
        VALUES($1,$2,$3,$4,$5,$6)`, [row.id, user.id, call.id, hash(call.transcript), index, sealed(row, payload)]);
    }
  });
  res.json({ actions: (await rowsFor(call, user)).rows.map(receipt) });
});
fileActionsRouter.get('/:id/file-actions/:action/options', async (req, res) => {
  const { user, call, payload } = await actionFor(req);
  await connected(user);
  if (payload.channel !== 'telegram') throw new HttpError(409, 'channel_unavailable', 'WhatsApp file sending is not connected yet.');
  res.json(await remote(user, 'options', { phone: call.destination }));
});
fileActionsRouter.post('/:id/file-actions/:action/review', async (req, res) => {
  const { user, call, action, payload } = await actionFor(req);
  await connected(user);
  if (payload.channel !== 'telegram') throw new HttpError(409, 'channel_unavailable');
  if (!['needs_details', 'ready_for_review', 'failed'].includes(action.status)) throw new HttpError(409, 'action_locked');
  if (req.body?.version !== action.version) throw new HttpError(409, 'action_changed');
  const prepared = await remote(user, 'prepare', { phone: call.destination, document_id: req.body.document_id,
    customer_id: req.body.customer_id, caption: req.body.caption });
  if (!/^[a-f0-9]{64}$/.test(prepared.approval_hash || '') || !prepared.file?.id || !prepared.recipient?.id) throw new HttpError(503, 'invalid_minime_result');
  const next = { ...payload, caption: prepared.caption, file: prepared.file, recipient: prepared.recipient, approval_hash: prepared.approval_hash };
  const updated = await queryOne(`UPDATE file_actions SET payload=$4,version=version+1,status='ready_for_review',
    execution_id=NULL,message_id=NULL,error_code=NULL,updated_at=now()
    WHERE id=$1 AND user_id=$2 AND version=$3 AND status IN ('needs_details','ready_for_review','failed') RETURNING *`,
  [action.id, user.id, action.version, sealed(action, next)]);
  if (!updated) throw new HttpError(409, 'action_changed');
  res.json({ action: receipt(updated), preview_url: prepared.preview_url });
});
fileActionsRouter.post('/:id/file-actions/:action/dismiss', async (req, res) => {
  const { user, action } = await actionFor(req);
  const updated = await queryOne(`UPDATE file_actions SET status='dismissed',version=version+1,updated_at=now()
    WHERE id=$1 AND user_id=$2 AND version=$3 AND status IN ('needs_details','ready_for_review','failed') RETURNING *`,
  [action.id, user.id, req.body?.version]);
  if (!updated) throw new HttpError(409, 'action_changed');
  res.json({ action: receipt(updated) });
});
async function finish(action, result) {
  const status = ['sending', 'sent', 'failed', 'unknown'].includes(result?.status) ? result.status : 'unknown';
  const confirmed = status === 'sent' && Number.isSafeInteger(Number(result.message_id)) && Number(result.message_id) > 0;
  const updated = await queryOne(`UPDATE file_actions SET status=$3,message_id=$4,error_code=$5,updated_at=now()
    WHERE id=$1 AND execution_id=$2 AND status IN ('sending','unknown') RETURNING *`,
  [action.id, action.execution_id, status === 'sent' && !confirmed ? 'unknown' : status,
    confirmed ? result.message_id : null, status === 'failed' ? 'send_failed' : status === 'unknown' || (status === 'sent' && !confirmed) ? 'check_status' : null]);
  return receipt(updated || await queryOne('SELECT * FROM file_actions WHERE id=$1', [action.id]));
}
fileActionsRouter.post('/:id/file-actions/:action/send', async (req, res) => {
  const { user, call, action } = await actionFor(req);
  await connected(user);
  const claimed = await withTransaction(async tx => {
    // Lock source and action so a concurrent approval or deletion cannot win before this claim.
    const { rows: [source] } = await tx.query('SELECT * FROM calls WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [call.id, user.id]);
    const { rows: [link] } = await tx.query('SELECT user_id FROM minime_links WHERE user_id=$1 FOR UPDATE', [user.id]);
    if (!link) throw new HttpError(409, 'minime_not_linked');
    const { rows: [current] } = await tx.query('SELECT * FROM file_actions WHERE id=$1 AND user_id=$2 FOR UPDATE', [action.id, user.id]);
    if (!source || !current) throw new HttpError(404, 'action_not_found');
    if (['sending','unknown','sent'].includes(current.status)) return null;
    if (current.status !== 'ready_for_review' || current.version !== req.body?.version || current.source_hash !== hash(source.transcript || '')) throw new HttpError(409, 'action_changed');
    const payload = decode(current).payload;
    if (payload.channel !== 'telegram' || !payload.approval_hash) throw new HttpError(409, 'review_required');
    const { rows: [updated] } = await tx.query(`UPDATE file_actions SET status='sending',execution_id=$2,updated_at=now() WHERE id=$1 RETURNING *`, [current.id, randomUUID()]);
    return updated;
  });
  if (!claimed) return res.json({ action: receipt(await queryOne('SELECT * FROM file_actions WHERE id=$1', [action.id])) });
  const payload = decode(claimed).payload;
  let result;
  try { result = await minimePost({ operation: 'send', user_id: user.id, send_id: claimed.execution_id,
    phone: call.destination, document_id: payload.file.id, customer_id: payload.recipient.id,
    caption: payload.caption, approval_hash: payload.approval_hash }, { path: '/api/dimts/files' }); }
  catch (e) {
    const refusedBeforeSend = [400, 401].includes(e.status) || (e.status === 409 &&
      ['selection_changed','not_linked','recipient_changed','file_unavailable','file_size_unsupported'].includes(e.code));
    result = { status: refusedBeforeSend ? 'failed' : 'unknown' };
  }
  res.json({ action: await finish(claimed, result) });
});
fileActionsRouter.post('/:id/file-actions/:action/status', async (req, res) => {
  const { user, action } = await actionFor(req);
  await connected(user);
  if (!action.execution_id || !['sending','unknown'].includes(action.status)) return res.json({ action: receipt(action) });
  const result = await remote(user, 'status', { send_id: action.execution_id });
  res.json({ action: await finish(action, result) });
});
