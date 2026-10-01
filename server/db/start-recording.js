import { queryOne } from './pool.js';
import { startCallRecording } from '../services/start-recording.js';

export async function beginAgreedRecording(callId, childSid) {
  const call = await queryOne(`UPDATE calls SET recording_start_status='pending'
    WHERE id=$1 AND child_call_sid=$2 AND record_enabled AND parent_consent_at IS NOT NULL
      AND child_consent_at IS NOT NULL AND twilio_call_sid IS NOT NULL
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
  return queryOne(`UPDATE calls SET recording_start_status='started',recording_sid=$2
    WHERE id=$1 AND recording_start_status='pending' RETURNING *`, [callId, sid])
    .then(row => row ?? queryOne('SELECT * FROM calls WHERE id=$1', [callId]));
}
