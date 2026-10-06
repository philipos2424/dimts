import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import * as database from '../db/pool.js';
import { resolveUser, HttpError } from '../lib/users.js';
import { validateReviewedFollowups } from '../services/followups.js';
import { createCalendarEvent, findCalendarEvent } from '../services/calendar.js';
import { sealJson } from '../lib/field-crypto.js';

export const calendarActionsRouter = Router();
const transcriptHash = text => createHash('sha256').update(text).digest('hex');
function receipt(action) {
  return { id: action.id, status: action.status, event_id: action.status === 'confirmed' ? action.event_id : null,
    event_url: action.event_url, error_code: action.error_code, proposal_version: action.proposal_version,
    meeting: action.meeting, updated_at: action.updated_at };
}
calendarActionsRouter.get('/:id/followups/meeting/action', async (req, res) => {
  const user = await resolveUser(req);
  const call = await database.queryOne('SELECT id FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
  if (!call) throw new HttpError(404, 'call_not_found');
  const action = await database.queryOne('SELECT * FROM calendar_actions WHERE call_id=$1 AND user_id=$2', [call.id, user.id]);
  res.json({ action: action ? receipt(action) : null });
});
async function finish(action, token, result) {
  const row = await database.queryOne(`UPDATE calendar_actions SET status=$3,event_url=$4,error_code=$5,
    lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING *`,
    [action.id, token, result.status, result.event_url ?? null, result.error_code ?? null]);
  // If storage fails after a provider commit, the pending record is reconciled
  // later using GET. A retried HTTP request never performs another blind POST.
  return receipt(row ?? await database.queryOne('SELECT * FROM calendar_actions WHERE id=$1', [action.id]));
}
calendarActionsRouter.post('/:id/followups/meeting/action', async (req, res) => {
  const user = await resolveUser(req), token = randomUUID();
  const reservation = await database.withTransaction(async tx => {
    const { rows: [call] } = await tx.query('SELECT * FROM calls WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, user.id]);
    if (!call) throw new HttpError(404, 'call_not_found');
    const { rows: [existing] } = await tx.query('SELECT * FROM calendar_actions WHERE call_id=$1', [call.id]);
    if (existing && existing.status !== 'failed') return { action: existing, create: false };
    if (!Number.isInteger(req.body?.version) || req.body.version !== call.followups_version) throw new HttpError(409, 'draft_changed');
    if (call.status !== 'ready' || !call.transcript || !call.followups?.source_hash || call.followups.source_hash !== transcriptHash(call.transcript))
      throw new HttpError(409, 'proposal_source_changed', 'Prepare follow-ups from the current transcript before booking.');
    if (call.followups.meeting?.status !== 'pending' || !call.followups.meeting?.evidence?.quotes?.length ||
        call.followups.meeting.evidence.quotes.some(q => !call.transcript.includes(q))) throw new HttpError(409, 'meeting_not_reviewable');
    let meeting;
    try { meeting = validateReviewedFollowups(call.followups).meeting; }
    catch { throw new HttpError(400, 'invalid_meeting'); }
    if (!meeting?.title || !meeting.start || !meeting.end) throw new HttpError(400, 'meeting_details_required');
    const { rows: [connection] } = await tx.query("SELECT connection_id FROM google_connections WHERE user_id=$1 AND kind='calendar'", [user.id]);
    if (!connection) throw new HttpError(409, 'google_calendar_not_connected', 'Connect Google Calendar in Settings first.');
    const id = existing?.id ?? randomUUID();
    const { rows: [action] } = await tx.query(`INSERT INTO calendar_actions(id,call_id,user_id,connection_id,proposal_version,meeting,status,event_id,lease_token,lease_until)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,now()+interval '2 minutes')
      ON CONFLICT(call_id) DO UPDATE SET connection_id=excluded.connection_id,proposal_version=excluded.proposal_version,
        meeting=excluded.meeting,status='pending',error_code=NULL,lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=now() RETURNING *`,
      [id, call.id, user.id, connection.connection_id, call.followups_version,
        sealJson(meeting, { userId: user.id, rowId: id, field: 'calendar_actions:meeting' }), id.replaceAll('-', ''), token]);
    return { action, create: true };
  });
  if (!reservation.create) return res.json({ action: receipt(reservation.action) });
  res.json({ action: await finish(reservation.action, token, await createCalendarEvent(reservation.action)) });
});
calendarActionsRouter.post('/:id/followups/meeting/action/reconcile', async (req, res) => {
  const user = await resolveUser(req), token = randomUUID();
  const action = await database.queryOne(`UPDATE calendar_actions SET lease_token=$3,lease_until=now()+interval '2 minutes',updated_at=now()
    WHERE call_id=$1 AND user_id=$2 AND status IN ('pending','unknown') AND (lease_until IS NULL OR lease_until<now()) RETURNING *`, [req.params.id, user.id, token]);
  if (!action) {
    const existing = await database.queryOne('SELECT * FROM calendar_actions WHERE call_id=$1 AND user_id=$2', [req.params.id, user.id]);
    if (!existing) throw new HttpError(404, 'action_not_found');
    return res.json({ action: receipt(existing) });
  }
  res.json({ action: await finish(action, token, await findCalendarEvent(action)) });
});
