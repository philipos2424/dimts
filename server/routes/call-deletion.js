import express from 'express';
import * as db from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { defer } from '../lib/defer.js';
import { processDeletion } from '../services/process-deletion.js';
import { assertDeletable, needsDeletionWork, scrubCall } from '../services/scrub-call.js';
import { audit } from '../lib/audit.js';

export const callDeletionRouter = express.Router();
export const deletionsRouter = express.Router();
deletionsRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  const result = await db.query(`SELECT id,deleted_at,provider_deletion_status,provider_deletion_error,provider_deleted_at,storage_deletion_status
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
    await assertDeletable(tx, current);
    const deleted = await scrubCall(tx, current);
    return deleted;
  });
  if (needsDeletionWork(call)) defer(processDeletion(call.id), `delete:${call.id}`);
  await audit({ userId: user.id, action: 'call_deleted', targetType: 'call', targetId: call.id, req });
  res.status(202).json({ id: call.id, deleted_at: call.deleted_at, provider_deletion_status: call.provider_deletion_status,
    storage_deletion_status: call.storage_deletion_status });
});
callDeletionRouter.post('/:id/deletion/retry', async (req, res) => {
  const user = await resolveUser(req);
  const call = await db.queryOne('SELECT * FROM calls WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL', [req.params.id, user.id]);
  if (!call) throw new HttpError(404, 'call_not_found');
  if (!needsDeletionWork(call)) return res.json({ status: call.provider_deletion_status });
  if (call.provider_deletion_attempted_at && Date.now()-new Date(call.provider_deletion_attempted_at).getTime()<60_000) throw new HttpError(429, 'deletion_retry_cooldown');
  defer(processDeletion(call.id), `delete-retry:${call.id}`);
  res.status(202).json({ status: 'pending' });
});
