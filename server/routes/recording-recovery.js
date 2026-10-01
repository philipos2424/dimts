import express from 'express';
import { randomUUID } from 'node:crypto';
import { queryOne } from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { findCompletedRecording } from '../services/find-recording.js';
import { processRecording } from '../services/process-recording.js';
import { defer } from '../lib/defer.js';

export const recordingRecoveryRouter = express.Router();
recordingRecoveryRouter.post('/:id/recording/reconcile', async (req, res) => {
  const user = await resolveUser(req);
  const current = await queryOne('SELECT * FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
  if (!current) throw new HttpError(404, 'call_not_found');
  if (current.recording_url) return res.json({ status: 'available' });
  if (!current.record_enabled || !current.parent_consent_at || !current.child_consent_at ||
    current.duration_sec == null || !current.twilio_call_sid) throw new HttpError(409, 'recording_not_recoverable', 'Only finished calls with both recording agreements can be checked.');
  const token = randomUUID();
  const call = await queryOne(`UPDATE calls SET recording_lookup_token=$3,recording_lookup_until=now()+interval '1 minute'
    WHERE id=$1 AND user_id=$2 AND recording_url IS NULL AND record_enabled
      AND parent_consent_at IS NOT NULL AND child_consent_at IS NOT NULL AND duration_sec IS NOT NULL
      AND (recording_lookup_until IS NULL OR recording_lookup_until < now()) RETURNING *`, [current.id, user.id, token]);
  if (!call) {
    const latest = await queryOne('SELECT recording_url FROM calls WHERE id=$1 AND user_id=$2', [current.id, user.id]);
    if (latest?.recording_url) return res.json({ status: 'available' });
    throw new HttpError(429, 'recording_check_cooldown', 'Please wait a minute before checking again.');
  }
  let recording;
  try { recording = await findCompletedRecording(call); }
  catch { throw new HttpError(503, 'recording_lookup_failed', 'The recording provider could not be checked. Please try again in a minute.'); }
  if (recording.status !== 'found') return res.json({ status: recording.status });
  const saved = await queryOne(`UPDATE calls SET recording_url=$4,recording_sid=$5,
      recording_start_status='started',status='processing',error=NULL,processing_requested_at=now()
    WHERE id=$1 AND user_id=$2 AND recording_lookup_token=$3 AND recording_url IS NULL
      AND record_enabled AND parent_consent_at IS NOT NULL AND child_consent_at IS NOT NULL
      AND duration_sec IS NOT NULL AND (recording_sid IS NULL OR recording_sid=$5) RETURNING id`,
    [call.id, user.id, token, recording.url, recording.sid]);
  if (saved) {
    defer(processRecording(saved.id), `recover:${saved.id}`);
    return res.status(202).json({ status: 'processing' });
  }
  const latest = await queryOne('SELECT recording_url FROM calls WHERE id=$1 AND user_id=$2', [call.id, user.id]);
  if (latest?.recording_url) return res.json({ status: 'available' });
  throw new HttpError(409, 'recording_changed', 'The call changed while checking its recording. Refresh before trying again.');
});
