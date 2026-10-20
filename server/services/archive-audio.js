import { captureCallFailure } from '../lib/sentry.js';
import { query, queryOne } from '../db/pool.js';
import { defer } from '../lib/defer.js';
import { fetchRecording } from './originate.js';
import { recordingChannels } from '../lib/recording-channels.js';
import { audioStoreConfigured, headAudio, objectKey, putAudio, removeAudio } from './audio-store.js';
import { deleteProviderRecording } from './delete-recording.js';

/**
 * Copy a finished recording into EU storage. Twilio's copy is only queued for
 * removal after an independent size check proves the stored object is whole.
 * An app call's own-voice upload has no carrier copy (`providerCopy: false`),
 * so there is nothing to queue.
 */
export async function archiveAudio(call, bytes, { providerCopy = true } = {}) {
  if (!audioStoreConfigured()) return 'skipped';
  const key = objectKey(call.user_id, call.id);
  try {
    const expected = await putAudio(key, bytes);
    const stored = await headAudio(key);
    if (stored?.size !== expected) throw new Error('Stored audio size does not match');
  } catch (err) {
    captureCallFailure(err, { callId: call.id, userId: call.user_id, stage: 'archive' });
    console.error('[archive] upload failed for call', call.id, err?.message);
    await queryOne(`UPDATE calls SET provider_archive_status='upload_failed'
      WHERE id=$1 AND audio_object_key IS NULL RETURNING id`, [call.id]);
    return 'upload_failed';
  }
  const saved = await queryOne(`UPDATE calls SET audio_object_key=$2,audio_archived_at=now(),provider_archive_status=$3
    WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [call.id, key, providerCopy ? 'pending' : 'removed']);
  if (!saved) {
    // Deleted while uploading: the stored copy must not outlive the call.
    await removeAudio(key);
    return 'skipped';
  }
  return 'stored';
}

/** Remove Twilio's copy of an archived recording; at most one attempt a minute. */
export async function removeArchivedFromProvider(callId) {
  const call = await queryOne(`UPDATE calls SET provider_archive_attempted_at=now()
    WHERE id=$1 AND audio_object_key IS NOT NULL AND deleted_at IS NULL
      AND provider_archive_status IN ('pending','unknown')
      AND (provider_archive_attempted_at IS NULL OR provider_archive_attempted_at < now()-interval '1 minute')
    RETURNING *`, [callId]);
  if (!call) return 'skipped';
  const result = await deleteProviderRecording(call);
  if (result.status !== 'confirmed') captureCallFailure(new Error(), { callId, userId: call.user_id, stage: 'archive_remove' });
  const status = result.status === 'confirmed' ? 'removed' : 'unknown';
  await queryOne(`UPDATE calls SET provider_archive_status=$2 WHERE id=$1 AND audio_object_key IS NOT NULL RETURNING id`, [callId, status]);
  return status;
}

async function retryUpload(call) {
  const response = await fetchRecording(call.recording_url, { channels: recordingChannels(call), recordingSid: call.recording_sid });
  if (!response.ok) {
    captureCallFailure(new Error(`Could not download recording (HTTP ${response.status})`), { callId: call.id, userId: call.user_id, stage: 'recording_fetch' });
    return 'upload_failed';
  }
  return archiveAudio(call, new Uint8Array(await response.arrayBuffer()));
}

/**
 * Piggy-backs on the user opening their calls (the same pattern as the stale
 * call reaper): retry unfinished Twilio removals and failed uploads, a few at
 * a time, without a separate scheduler.
 */
export async function scheduleArchiveRetries(userId) {
  const { rows: removals } = await query(`SELECT id FROM calls WHERE user_id=$1 AND deleted_at IS NULL
    AND audio_object_key IS NOT NULL AND provider_archive_status IN ('pending','unknown')
    AND (provider_archive_attempted_at IS NULL OR provider_archive_attempted_at < now()-interval '1 minute')
    ORDER BY created_at LIMIT 3`, [userId]);
  for (const { id } of removals) defer(removeArchivedFromProvider(id), `archive-remove:${id}`);
  const { rows: uploads } = await query(`SELECT id,user_id,recording_url,recording_sid,voicemail FROM calls WHERE user_id=$1 AND deleted_at IS NULL
    AND audio_object_key IS NULL AND recording_url IS NOT NULL AND provider_archive_status='upload_failed'
    AND status IN ('ready','failed') ORDER BY created_at LIMIT 1`, [userId]);
  for (const call of uploads) defer(retryUpload(call).catch(err => {
    captureCallFailure(err, { callId: call.id, userId: call.user_id, stage: 'archive' });
    throw err;
  }), `archive-retry:${call.id}`);
}
