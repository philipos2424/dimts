import { randomUUID } from 'node:crypto';
import { queryOne } from '../db/pool.js';
import { deleteProviderRecording } from './delete-recording.js';
import { removeAudio } from './audio-store.js';

/**
 * Remove a deleted call's audio from Twilio and from EU storage. One worker
 * owns the job at a time; each store records its own verified outcome.
 */
export async function processDeletion(callId) {
  const token = randomUUID();
  const call = await queryOne(`UPDATE calls SET provider_deletion_token=$2,
      provider_deletion_until=now()+interval '1 minute',provider_deletion_attempted_at=now(),
      provider_deletion_status=CASE WHEN provider_deletion_status='unknown' THEN 'pending' ELSE provider_deletion_status END,
      provider_deletion_error=CASE WHEN provider_deletion_status IN ('pending','unknown') THEN NULL ELSE provider_deletion_error END
    WHERE id=$1 AND deleted_at IS NOT NULL
      AND (provider_deletion_status IN ('pending','unknown') OR storage_deletion_status IN ('pending','unknown'))
      AND (provider_deletion_until IS NULL OR provider_deletion_until<now())
      AND (provider_deletion_attempted_at IS NULL OR provider_deletion_attempted_at<now()-interval '1 minute')
    RETURNING *`, [callId, token]);
  if (!call) return { status: 'skipped' };
  let result = { status: call.provider_deletion_status };
  if (call.provider_deletion_status === 'pending') {
    result = await deleteProviderRecording(call);
    await queryOne(`UPDATE calls SET provider_deletion_status=$3,provider_deletion_error=$4,
        provider_deleted_at=CASE WHEN $3='confirmed' THEN now() ELSE NULL END
      WHERE id=$1 AND deleted_at IS NOT NULL AND provider_deletion_token=$2
        AND recording_sid IS NOT DISTINCT FROM $5 RETURNING id`,
      [callId, token, result.status, result.error ?? null, call.recording_sid]);
  }
  if (['pending','unknown'].includes(call.storage_deletion_status) && call.audio_object_key) {
    const stored = await removeAudio(call.audio_object_key);
    await queryOne(`UPDATE calls SET storage_deletion_status=$3,
        audio_object_key=CASE WHEN $3='confirmed' THEN NULL ELSE audio_object_key END
      WHERE id=$1 AND provider_deletion_token=$2 RETURNING id`, [callId, token, stored]);
  }
  await queryOne(`UPDATE calls SET provider_deletion_token=NULL,provider_deletion_until=NULL
    WHERE id=$1 AND provider_deletion_token=$2 RETURNING id`, [callId, token]);
  return result;
}
