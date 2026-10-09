import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import * as database from '../db/pool.js';
import { resolveUser, HttpError } from '../lib/users.js';
import { validateReviewedFollowups } from '../services/followups.js';
import { createGmailDraft, findGmailDraft } from '../services/gmail.js';
import { sealJson } from '../lib/field-crypto.js';

export const emailActionsRouter = Router();
function receipt(action) {
  return { id: action.id, status: action.status, draft_id: action.status === 'confirmed' ? action.draft_id : null,
    error_code: action.error_code, proposal_version: action.proposal_version, email: action.email, updated_at: action.updated_at };
}
emailActionsRouter.get('/:id/followups/email/action', async (req, res) => {
  const user = await resolveUser(req);
  const call = await database.queryOne('SELECT id FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
  if (!call) throw new HttpError(404, 'call_not_found');
  const action = await database.queryOne('SELECT * FROM email_actions WHERE call_id=$1 AND user_id=$2', [call.id, user.id]);
  res.json({ action: action ? receipt(action) : null });
});
async function finish(action, token, result) {
  const row = await database.queryOne(`UPDATE email_actions SET status=$3,draft_id=$4,error_code=$5,
    lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING *`,
    [action.id, token, result.status, result.draft_id ?? null, result.error_code ?? null]);
  return receipt(row ?? await database.queryOne('SELECT * FROM email_actions WHERE id=$1', [action.id]));
}
emailActionsRouter.post('/:id/followups/email/action', async (req, res) => {
  const user = await resolveUser(req), token = randomUUID();
  const reservation = await database.withTransaction(async tx => {
    const { rows: [call] } = await tx.query('SELECT * FROM calls WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, user.id]);
    if (!call) throw new HttpError(404, 'call_not_found');
    const { rows: [existing] } = await tx.query('SELECT * FROM email_actions WHERE call_id=$1', [call.id]);
    if (existing && existing.status !== 'failed') return { action: existing, create: false };
    if (!Number.isInteger(req.body?.version) || req.body.version !== call.followups_version) throw new HttpError(409, 'draft_changed');
    if (call.status !== 'ready' || !call.transcript || !call.followups?.source_hash ||
        call.followups.source_hash !== createHash('sha256').update(call.transcript).digest('hex')) throw new HttpError(409, 'proposal_source_changed');
    if (call.followups.email?.status !== 'pending' || !call.followups.email?.evidence?.quotes?.length ||
        call.followups.email.evidence.quotes.some(q => !call.transcript.includes(q))) throw new HttpError(409, 'email_not_reviewable');
    let email;
    try { email = validateReviewedFollowups(call.followups).email; }
    catch { throw new HttpError(400, 'invalid_email'); }
    if (!email?.recipient || !email.subject || !email.body || /[\r\n]/.test(email.subject)) throw new HttpError(400, 'email_details_required');
    const { rows: [connection] } = await tx.query("SELECT connection_id FROM google_connections WHERE user_id=$1 AND kind='gmail'", [user.id]);
    if (!connection) throw new HttpError(409, 'gmail_not_connected', 'Connect Gmail in Settings first.');
    const id = existing?.id ?? randomUUID();
    const { rows: [action] } = await tx.query(`INSERT INTO email_actions(id,call_id,user_id,connection_id,proposal_version,email,status,message_key,lease_token,lease_until)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,now()+interval '2 minutes')
      ON CONFLICT(call_id) DO UPDATE SET connection_id=excluded.connection_id,proposal_version=excluded.proposal_version,
        email=excluded.email,status='pending',error_code=NULL,draft_id=NULL,lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=now() RETURNING *`,
      [id, call.id, user.id, connection.connection_id, call.followups_version,
        sealJson(email, { userId: user.id, rowId: id, field: 'email_actions:email' }), `dimts-${id}@dimts.invalid`, token]);
    return { action, create: true };
  });
  if (!reservation.create) return res.json({ action: receipt(reservation.action) });
  res.json({ action: await finish(reservation.action, token, await createGmailDraft(reservation.action)) });
});
emailActionsRouter.post('/:id/followups/email/action/reconcile', async (req, res) => {
  const user = await resolveUser(req), token = randomUUID();
  const action = await database.queryOne(`UPDATE email_actions SET lease_token=$3,lease_until=now()+interval '2 minutes',updated_at=now()
    WHERE call_id=$1 AND user_id=$2 AND status IN ('pending','unknown') AND (lease_until IS NULL OR lease_until<now()) RETURNING *`, [req.params.id, user.id, token]);
  if (!action) {
    const existing = await database.queryOne('SELECT * FROM email_actions WHERE call_id=$1 AND user_id=$2', [req.params.id, user.id]);
    if (!existing) throw new HttpError(404, 'action_not_found');
    return res.json({ action: receipt(existing) });
  }
  res.json({ action: await finish(action, token, await findGmailDraft(action)) });
});
