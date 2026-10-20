import { captureCallFailure } from '../lib/sentry.js';
import { query } from './pool.js';
export const EXPIRE_PROCESSING_SQL = `UPDATE calls SET status='failed',
  error='The recording is saved, but call notes did not finish. Retry processing to continue.',
  processing_token=NULL,processing_until=NULL
  WHERE user_id=$1 AND status='processing' AND recording_url IS NOT NULL
    AND (route <> 'app' OR processing_until IS NOT NULL)
    AND ((processing_until IS NOT NULL AND processing_until < now())
      OR (processing_until IS NULL AND processing_requested_at < now()-interval '10 minutes'))`;
// An app call whose notes wait for the other person's upload has no lease
// (processing_until NULL) and is resolved by the app sweep, not failed here;
// a lease that expired mid-work is failed like any other.
export async function expireProcessing(userId) {
  // Older queued rows have no request timestamp. Start their waiting window on
  // first observation instead of guessing from when the phone call began.
  await query(`UPDATE calls SET processing_requested_at=now() WHERE user_id=$1
    AND status='processing' AND recording_url IS NOT NULL
    AND processing_until IS NULL AND processing_requested_at IS NULL`, [userId]);
  const result = await query(EXPIRE_PROCESSING_SQL + ' RETURNING id', [userId]);
  for (const row of result.rows) captureCallFailure(new Error('Processing lease expired'), { callId: row.id, userId, stage: 'processing_timeout' });
  return result;
}
