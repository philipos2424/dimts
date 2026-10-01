import { randomUUID } from 'node:crypto';
import { queryOne } from '../db/pool.js';
import { deleteProviderRecording } from './delete-recording.js';

export async function processDeletion(callId) {
  const token = randomUUID();
  const call = await queryOne(`UPDATE calls SET provider_deletion_token=$2,
      provider_deletion_until=now()+interval '1 minute',provider_deletion_attempted_at=now(),
      provider_deletion_status='pending',provider_deletion_error=NULL
    WHERE id=$1 AND deleted_at IS NOT NULL AND provider_deletion_status IN ('pending','unknown')
      AND (provider_deletion_until IS NULL OR provider_deletion_until<now())
      AND (provider_deletion_attempted_at IS NULL OR provider_deletion_attempted_at<now()-interval '1 minute')
    RETURNING *`, [callId, token]);
  if (!call) return { status: 'skipped' };
  const result = await deleteProviderRecording(call);
  await queryOne(`UPDATE calls SET provider_deletion_status=$3,provider_deletion_error=$4,
      provider_deleted_at=CASE WHEN $3='confirmed' THEN now() ELSE NULL END,
      provider_deletion_token=NULL,provider_deletion_until=NULL
    WHERE id=$1 AND deleted_at IS NOT NULL AND provider_deletion_token=$2
      AND recording_sid IS NOT DISTINCT FROM $5 RETURNING id`,
    [callId, token, result.status, result.error ?? null, call.recording_sid]);
  return result;
}
