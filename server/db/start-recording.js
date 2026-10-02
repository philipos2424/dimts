import { queryOne } from './pool.js';
import { startCallRecording } from '../services/start-recording.js';
import { processDeletion } from '../services/process-deletion.js';
import { defer } from '../lib/defer.js';
import { recordingAuthorizationSql } from '../lib/recording-policy.js';

export async function beginAgreedRecording(callId, childSid) {
  const call = await queryOne(`UPDATE calls SET recording_start_status='pending'
    WHERE id=$1 AND child_call_sid=$2 AND ${recordingAuthorizationSql} AND twilio_call_sid IS NOT NULL
      AND recording_start_status IS NULL AND duration_sec IS NULL RETURNING *`, [callId, childSid]);
  if (!call) return queryOne('SELECT * FROM calls WHERE id=$1', [callId]);
  let sid;
  try { sid = await startCallRecording(call); }
  catch (err) {
    const definite = [400,401,403,404,422].includes(err.status);
    // A timeout may have started a recording. Never issue a second create.
    return queryOne(`UPDATE calls SET recording_start_status=$2,
      record_enabled=CASE WHEN $3 THEN false ELSE record_enabled END
      WHERE id=$1 AND recording_start_status='pending' RETURNING *`, [callId, definite ? 'failed' : 'unknown', definite])
      .then(row => row ?? queryOne('SELECT * FROM calls WHERE id=$1', [callId]));
  }
  const saved = await queryOne(`UPDATE calls SET recording_start_status='started',recording_sid=$2,
      provider_deletion_status=CASE WHEN deleted_at IS NOT NULL THEN 'pending' ELSE provider_deletion_status END,
      provider_deleted_at=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE provider_deleted_at END,
      provider_deletion_token=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE provider_deletion_token END,
      provider_deletion_until=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE provider_deletion_until END,
      provider_deletion_attempted_at=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE provider_deletion_attempted_at END
    WHERE id=$1 AND recording_start_status='pending' RETURNING *`, [callId, sid])
    .then(row => row ?? queryOne('SELECT * FROM calls WHERE id=$1', [callId]));
  if (saved?.deleted_at) defer(processDeletion(callId), `late-start-delete:${callId}`);
  return saved;
}
