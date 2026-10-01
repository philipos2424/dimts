import express from 'express';
import * as db from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { defer } from '../lib/defer.js';
import { processDeletion } from '../services/process-deletion.js';

export const callDeletionRouter = express.Router();
export const deletionsRouter = express.Router();
deletionsRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  const result = await db.query(`SELECT id,deleted_at,provider_deletion_status,provider_deletion_error,provider_deleted_at
    FROM calls WHERE user_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100`, [user.id]);
  res.json({ deletions: result.rows });
});
callDeletionRouter.delete('/:id', async (req, res) => {
  const user = await resolveUser(req);
  if (req.body?.confirm !== 'delete-call') throw new HttpError(400, 'deletion_confirmation_required');
  const call = await db.withTransaction(async tx => {
    const { rows: [current] } = await tx.query('SELECT * FROM calls WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, user.id]);
    if (!current) throw new HttpError(404, 'call_not_found');
    if (current.deleted_at) return current;
    if (['initiating','ringing','in-progress'].includes(current.status) ||
        (current.duration_sec == null && !current.budget_released)) throw new HttpError(409, 'call_not_finished', 'Wait until the call has finished before deleting it.');
    for (const table of ['calendar_actions','email_actions']) {
      const { rows } = await tx.query(`SELECT id FROM ${table} WHERE call_id=$1 AND status IN ('pending','unknown')`, [current.id]);
      if (rows.length) throw new HttpError(409, 'external_action_unresolved', 'Check the pending calendar or Gmail action before deleting this call.');
    }
    const needsProvider = !!(current.recording_url || current.recording_sid || current.recording_start_status === 'started' ||
      current.recording_start_status === 'unknown' || current.recording_start_status === 'pending');
    const { rows: [deleted] } = await tx.query(`UPDATE calls SET deleted_at=now(),status='deleted',record_enabled=false,
      destination='',user_phone='',contact_id=NULL,agent_number=NULL,recording_url=NULL,transcript=NULL,transcript_data=NULL,
      transcript_recording_url=NULL,summary=NULL,action_items=NULL,key_points=NULL,next_moves=NULL,followups=NULL,error=NULL,
      language=NULL,language_probability=NULL,processing_token=NULL,processing_until=NULL,
      recording_lookup_token=NULL,recording_lookup_until=NULL,
      provider_deletion_status=$2,provider_deletion_error=NULL WHERE id=$1 RETURNING *`,
      [current.id, needsProvider ? 'pending' : 'not_required']);
    await tx.query('DELETE FROM followup_events WHERE call_id=$1', [current.id]);
    await tx.query('DELETE FROM call_notifications WHERE call_id=$1', [current.id]);
    await tx.query("UPDATE calendar_actions SET meeting='{}'::jsonb WHERE call_id=$1", [current.id]);
    await tx.query("UPDATE email_actions SET email='{}'::jsonb WHERE call_id=$1", [current.id]);
    return deleted;
  });
  if (['pending','unknown'].includes(call.provider_deletion_status)) defer(processDeletion(call.id), `delete:${call.id}`);
  res.status(202).json({ id: call.id, deleted_at: call.deleted_at, provider_deletion_status: call.provider_deletion_status });
});
callDeletionRouter.post('/:id/deletion/retry', async (req, res) => {
  const user = await resolveUser(req);
  const call = await db.queryOne('SELECT * FROM calls WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL', [req.params.id, user.id]);
  if (!call) throw new HttpError(404, 'call_not_found');
  if (['confirmed','not_required'].includes(call.provider_deletion_status)) return res.json({ status: call.provider_deletion_status });
  if (call.provider_deletion_attempted_at && Date.now()-new Date(call.provider_deletion_attempted_at).getTime()<60_000) throw new HttpError(429, 'deletion_retry_cooldown');
  defer(processDeletion(call.id), `delete-retry:${call.id}`);
  res.status(202).json({ status: 'pending' });
});
