import * as database from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { processDeletion } from './process-deletion.js';
import { assertDeletable, needsDeletionWork, scrubCall } from './scrub-call.js';

export const RETENTION_MONTHS = [3, 6, 12, 24];

/**
 * Delete calls older than each owner's chosen retention period, exactly as if
 * the owner had pressed Delete. A call that cannot be deleted yet (an
 * unresolved Gmail or Calendar action) is skipped and retried the next day.
 */
export async function expireOldCalls({ limit = 200 } = {}) {
  const { rows } = await database.query(`SELECT c.id, c.user_id FROM calls c JOIN users u ON u.id=c.user_id
    WHERE u.retention_months IS NOT NULL AND u.deleted_at IS NULL AND c.deleted_at IS NULL
      AND c.created_at < now() - make_interval(months => u.retention_months)
    ORDER BY c.created_at LIMIT $1`, [limit]);
  let deleted = 0, skipped = 0;
  for (const { id, user_id: userId } of rows) {
    try {
      const call = await database.withTransaction(async tx => {
        const { rows: [current] } = await tx.query('SELECT * FROM calls WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id]);
        if (!current) return null;
        await assertDeletable(tx, current);
        return scrubCall(tx, current);
      });
      if (!call) continue;
      deleted++;
      await audit({ userId, action: 'call_auto_deleted', targetType: 'call', targetId: id });
      if (needsDeletionWork(call)) await processDeletion(id).catch(err => console.error('[retention] audio removal will be retried', err?.message));
    } catch (err) {
      skipped++;
      console.error('[retention] skipped a call', err?.code ?? err?.message);
    }
  }
  return { deleted, skipped };
}
