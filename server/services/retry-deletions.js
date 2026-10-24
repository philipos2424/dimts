import { query } from '../db/pool.js';
import { captureCallFailure } from '../lib/sentry.js';
import { processDeletion } from './process-deletion.js';

// Audio erasure not yet confirmed at the carrier or in storage.
const UNRESOLVED = `(provider_deletion_status IN ('pending','unknown') OR storage_deletion_status IN ('pending','unknown'))`;
const CHUNK = 5;

/**
 * Finish deletions that did not complete when the call or account was deleted.
 * A deletion tries once right after it commits, but a timeout or an outage
 * leaves the carrier or storage copy behind, and the owner cannot retry after
 * deleting their account. This scans every deleted call whose erasure is
 * unconfirmed, whether or not its owner still exists, and runs the same
 * leased, verified removal (processDeletion) on each.
 *
 * Fair: the call tried longest ago goes first, and one that keeps failing
 * waits `cooldownHours` between tries, so it cannot starve the others.
 * Bounded: it stops starting new work after `budgetMs` (always doing at least
 * one batch), and the next daily run carries on.
 * Loud: a call still unconfirmed after `overdueDays` is reported to monitoring
 * every run, by call id and stage only.
 */
export async function retryPendingDeletions({ limit = 25, cooldownHours = 1, overdueDays = 3, budgetMs = 90_000 } = {}) {
  const started = Date.now();
  const { rows } = await query(`SELECT id FROM calls
    WHERE deleted_at IS NOT NULL AND ${UNRESOLVED}
      AND (provider_deletion_attempted_at IS NULL OR provider_deletion_attempted_at < now() - $2::float * interval '1 hour')
    ORDER BY provider_deletion_attempted_at NULLS FIRST, deleted_at
    LIMIT $1`, [limit, cooldownHours]);
  const tried = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    if (i > 0 && Date.now() - started >= budgetMs) break;
    const batch = rows.slice(i, i + CHUNK);
    const results = await Promise.all(batch.map(({ id }) => processDeletion(id).catch(err => {
      console.error('[deletion-retry] an attempt failed and will be retried', err?.message);
      return { status: 'error' };
    })));
    batch.forEach(({ id }, index) => { if (results[index]?.status !== 'skipped') tried.push(id); });
  }
  const unresolved = tried.length ? (await query(`SELECT count(*)::int AS n FROM calls WHERE id = ANY($1::uuid[]) AND ${UNRESOLVED}`, [tried])).rows[0].n : 0;
  const { rows: overdue } = await query(`SELECT id FROM calls
    WHERE deleted_at IS NOT NULL AND deleted_at < now() - $1::float * interval '1 day' AND ${UNRESOLVED}
    ORDER BY deleted_at LIMIT 50`, [overdueDays]);
  for (const { id } of overdue) {
    captureCallFailure(new Error('A deleted call still has audio at the carrier or in storage'), { callId: id, stage: 'deletion_overdue' });
  }
  return { found: rows.length, attempted: tried.length, unresolved, overdue: overdue.length };
}
