import { createHash } from 'node:crypto';
import * as database from '../db/pool.js';
import { HttpError } from '../lib/users.js';
import { audit } from '../lib/audit.js';
import { defer } from '../lib/defer.js';
import { captureCallFailure } from '../lib/sentry.js';
import { encryptionEnabled } from '../lib/field-crypto.js';
import { hasRecordingAuthorization } from '../lib/recording-policy.js';
import { archiveAudio } from './archive-audio.js';
// A namespace import: tests that stub the store for phone recordings need not know about parts.
import * as audioStore from './audio-store.js';
import { processRecording } from './process-recording.js';
import { APP_RECORDING_PREFIX, appCallRows, peerAudioReady, peerCanContribute } from './app-call-transcript.js';

/*
 * After an app call each phone uploads its OWNER'S OWN VOICE, in parts of at
 * most 1 MiB (Vercel bodies stop at 4.5 MB). Parts wait in Postgres,
 * encrypted for the owner, until the upload is completed; then the whole file
 * is stored through archiveAudio exactly like a phone recording and the parts
 * are deleted. Unfinished parts are deleted after 48 hours.
 */
export const MAX_PART_BYTES = 1024 * 1024;
export const MAX_PARTS = 40;
export const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
/** Milliseconds from the shared 'connected' moment to when this phone's recorder started. */
export const MAX_OFFSET_MS = 600_000;
export const AUDIO_MIMES = Object.freeze(['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-m4a']);
const UPLOAD_HOURS = 48;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const query = (sql, params) => database.query(sql, params);
const queryOne = (sql, params) => database.queryOne(sql, params);
const notFound = () => new HttpError(404, 'call_not_found');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Each part is sealed under its own name, so parts cannot be swapped or replayed into another call.
const partKey = (userId, callId, index) => `${userId}/${callId}.part${index}`;

/**
 * Everything needed to decide whether this person may upload to this row.
 * A stranger, the other person on the call, a phone call and a deleted call
 * all look the same: not found.
 */
async function ownAppRow(user, callId) {
  if (!UUID.test(String(callId))) throw notFound();
  const row = await queryOne(`SELECT id, user_id, route, app_call_id, direction, record_enabled, deleted_at, duration_sec,
      consent_mode, consent_scope, other_party_notice_issued_at, parent_consent_at, child_consent_at, own_audio_complete_at
    FROM calls WHERE id=$1 AND user_id=$2`, [callId, user.id]);
  if (!row || row.route !== 'app' || row.deleted_at || !row.app_call_id) throw notFound();
  // The other person must have shown the recording notice (Task 3), and recording must still be on.
  if (!hasRecordingAuthorization(row)) throw new HttpError(409, 'recording_not_authorized', 'This call was not recorded.');
  return row;
}

/** Store one part. Repeating a part is harmless; a different part at the same index is refused. */
export async function storeAudioPart(user, callId, { index, total, sha256: claimed, body } = {}) {
  const row = await ownAppRow(user, callId);
  if (row.own_audio_complete_at) throw new HttpError(409, 'audio_already_complete', 'This recording is already uploaded.');
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_PARTS || !Number.isSafeInteger(index) || index < 0 || index >= total) {
    throw new HttpError(400, 'invalid_part', `Send parts numbered 0 to ${MAX_PARTS - 1}.`);
  }
  if (!(body instanceof Uint8Array) || body.length === 0) throw new HttpError(400, 'invalid_part', 'The part is empty.');
  if (body.length > MAX_PART_BYTES) throw new HttpError(413, 'part_too_large', 'Each part must be at most 1 MiB.');
  const digest = typeof claimed === 'string' ? claimed.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(digest) || sha256(body) !== digest) throw new HttpError(400, 'bad_checksum', 'The part did not arrive intact.');

  const { rows: existing } = await query('SELECT idx, total, sha256, size FROM app_call_audio_parts WHERE call_id=$1', [row.id]);
  if (existing.some(part => part.total !== total)) throw new HttpError(409, 'total_mismatch', 'The number of parts changed.');
  const same = existing.find(part => part.idx === index);
  if (same) {
    if (same.sha256 !== digest) throw new HttpError(409, 'part_conflict', 'A different part was already uploaded here.');
    return { index, stored: true };
  }
  if (existing.reduce((sum, part) => sum + part.size, 0) + body.length > MAX_AUDIO_BYTES) {
    throw new HttpError(413, 'audio_too_large', 'The recording is too large.');
  }
  const sealed = encryptionEnabled();
  const data = sealed ? audioStore.encryptAudio(partKey(row.user_id, row.id, index), body) : Buffer.from(body);
  const inserted = await queryOne(`INSERT INTO app_call_audio_parts(call_id, idx, total, sha256, size, encrypted, data)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (call_id, idx) DO NOTHING RETURNING idx`, [row.id, index, total, digest, body.length, sealed, data]);
  if (!inserted) {
    // Two uploads of the same index raced; the first one stands.
    const winner = await queryOne('SELECT sha256 FROM app_call_audio_parts WHERE call_id=$1 AND idx=$2', [row.id, index]);
    if (winner?.sha256 !== digest) throw new HttpError(409, 'part_conflict', 'A different part was already uploaded here.');
  }
  return { index, stored: true };
}

/**
 * Join the parts in order, store the file encrypted like a phone recording,
 * and start the notes for both people. A second call changes nothing.
 */
export async function completeOwnAudio(user, callId, { offsetMs, mime } = {}) {
  const row = await ownAppRow(user, callId);
  if (row.own_audio_complete_at) return { status: 'complete' };
  if (!Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs > MAX_OFFSET_MS) throw new HttpError(400, 'invalid_offset', 'offsetMs must be 0 to 600000.');
  if (!AUDIO_MIMES.includes(mime)) throw new HttpError(400, 'invalid_mime', 'This audio format is not supported.');
  if (!(row.duration_sec > 0)) throw new HttpError(409, 'call_not_finished', 'Upload the recording after the call has ended.');

  const { rows: parts } = await query(`SELECT idx, total, sha256, size, encrypted, data FROM app_call_audio_parts
    WHERE call_id=$1 ORDER BY idx`, [row.id]);
  const total = parts[0]?.total;
  if (!parts.length || parts.length !== total || parts.some((part, i) => part.idx !== i || part.total !== total)) {
    throw new HttpError(409, 'parts_missing', 'Some parts of the recording have not arrived.');
  }
  if (parts.reduce((sum, part) => sum + part.size, 0) > MAX_AUDIO_BYTES) throw new HttpError(413, 'audio_too_large', 'The recording is too large.');
  const pieces = [];
  for (const part of parts) {
    let bytes = null;
    try {
      const data = Buffer.from(part.data);
      bytes = part.encrypted ? audioStore.decryptAudio(partKey(row.user_id, row.id, part.idx), data) : data;
    } catch { /* unreadable: treated as missing below */ }
    if (!bytes || bytes.length !== part.size || sha256(bytes) !== part.sha256) {
      await query('DELETE FROM app_call_audio_parts WHERE call_id=$1 AND idx=$2', [row.id, part.idx]);
      throw new HttpError(409, 'parts_missing', 'Some parts of the recording have not arrived.');
    }
    pieces.push(bytes);
  }
  const audio = Buffer.concat(pieces);

  const stored = await archiveAudio({ id: row.id, user_id: row.user_id }, audio, { providerCopy: false });
  if (stored !== 'stored') throw new HttpError(503, 'audio_store_unavailable', 'Your recording could not be saved yet. Try again shortly.');
  const done = await queryOne(`UPDATE calls SET own_audio_complete_at=now(), own_audio_offset_ms=$2, own_audio_mime=$3,
      recording_url=$4 || app_call_id::text, processing_requested_at=now()
    WHERE id=$1 AND own_audio_complete_at IS NULL AND deleted_at IS NULL AND audio_object_key IS NOT NULL
    RETURNING id, app_call_id`, [row.id, offsetMs, mime, APP_RECORDING_PREFIX]);
  if (!done) {
    const now = await queryOne('SELECT own_audio_complete_at, deleted_at FROM calls WHERE id=$1', [row.id]);
    if (now?.own_audio_complete_at && !now.deleted_at) return { status: 'complete' };
    throw notFound();
  }
  await query('DELETE FROM app_call_audio_parts WHERE call_id=$1', [row.id]);
  await audit({ userId: user.id, action: 'app_call_audio_uploaded', targetType: 'call', targetId: row.id });
  const { peer } = await appCallRows(row.id);
  defer(processAppCallNotes(row.id), `app-notes:${row.id}`);
  if (peer) defer(processAppCallNotes(peer.id), `app-notes:${peer.id}`);
  return { status: 'complete' };
}

/**
 * Make this row's notes once they can be made well:
 *  (a) both people's files are in, or
 *  (b) this file is in and the other person cannot contribute (deleted the
 *      call, stopped recording, or was never recorded), or
 *  (c) this file is in and the call ended over 10 minutes ago: one-sided.
 * Otherwise do nothing; every upload and the lazy sweep call this again.
 */
export async function processAppCallNotes(callId) {
  const { own, peer } = await appCallRows(callId);
  if (!own || own.route !== 'app' || own.deleted_at || !own.own_audio_complete_at || own.status === 'ready') return { status: 'skipped' };
  if (!peerAudioReady(own, peer) && peerCanContribute(own, peer) && !own.wait_over) return { status: 'waiting' };
  await processRecording(callId);
  return { status: 'processed' };
}

// Measured from completion, like the phone rule, but an own-voice upload may
// resume for 48 hours (a dead battery, a killed app), so the wait is that long.
export const EXPIRE_APP_AUDIO_WAIT_SQL = `UPDATE calls SET status='failed',
  error='The call finished, but your notes could not be made because the recording was never received.'
  WHERE user_id=$1 AND route='app' AND status='processing' AND deleted_at IS NULL
    AND own_audio_complete_at IS NULL AND duration_sec IS NOT NULL
    AND completed_at < now() - make_interval(hours => ${UPLOAD_HOURS})`;

/**
 * The lazy sweep for app call audio (there is no cron): drop abandoned parts,
 * fail this person's rows whose upload never came, and retry the notes of
 * rows that are waiting for the other person.
 */
export async function sweepAppCallAudio(userId) {
  await query(`DELETE FROM app_call_audio_parts WHERE created_at < now() - make_interval(hours => ${UPLOAD_HOURS})`);
  const expired = await query(EXPIRE_APP_AUDIO_WAIT_SQL + ' RETURNING id', [userId]);
  for (const { id } of expired.rows) captureCallFailure(new Error('Own-voice recording did not arrive'), { callId: id, userId, stage: 'recording_wait' });
  const { rows: waiting } = await query(`SELECT id FROM calls WHERE user_id=$1 AND route='app' AND status='processing'
      AND deleted_at IS NULL AND own_audio_complete_at IS NOT NULL AND summary IS NULL
      AND (processing_until IS NULL OR processing_until < now())
    ORDER BY completed_at LIMIT 5`, [userId]);
  for (const { id } of waiting) defer(processAppCallNotes(id), `app-notes:${id}`);
}
