import { captureCallFailure } from '../lib/sentry.js';
import { query } from './pool.js';

// Measure from completion, never call creation: a long conversation must not
// time out while it is still in progress. A late signed callback can recover.
export const EXPIRE_RECORDING_WAIT_SQL = `UPDATE calls SET status='failed',
  error='The call finished, but its recording has not arrived. No transcript or summary is available. Refresh to check for delayed audio; if it stays missing, contact the operator with this call ID.'
  WHERE user_id=$1 AND status='processing' AND recording_url IS NULL
    AND duration_sec IS NOT NULL AND completed_at < now() - interval '10 minutes'`;

export async function expireRecordingWait(userId) {
  const result = await query(EXPIRE_RECORDING_WAIT_SQL + ' RETURNING id', [userId]);
  for (const row of result.rows) captureCallFailure(new Error('Recording did not arrive'), { callId: row.id, userId, stage: 'recording_wait' });
  return result;
}
