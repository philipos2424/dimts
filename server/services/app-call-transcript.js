import { queryOne } from '../db/pool.js';
import { hasRecordingAuthorization } from '../lib/recording-policy.js';
// Namespace imports: tests that stub these modules for the phone path need not know about app calls.
import * as audioStore from './audio-store.js';
import * as transcription from './transcribe.js';

/**
 * An app call row's recording_url is this marker plus the app call id once its
 * owner's own voice is stored, so every "recording_url IS NOT NULL" rule and
 * the transcript checkpoint (transcript_recording_url = recording_url) work as
 * for phone calls. It is never fetched.
 */
export const APP_RECORDING_PREFIX = 'dimts-app:';
/** One-sided notes are made this long after the call if the other upload is missing. */
export const PEER_WAIT_MINUTES = 10;

// Only what the audio and consent checks need: never the peer's sealed content.
const COLUMNS = `c.id, c.user_id, c.route, c.app_call_id, c.status, c.direction, c.record_enabled, c.deleted_at,
  c.consent_mode, c.consent_scope, c.other_party_notice_issued_at, c.parent_consent_at, c.child_consent_at,
  c.audio_object_key, c.own_audio_complete_at, c.own_audio_offset_ms, c.own_audio_mime, c.completed_at,
  (c.completed_at IS NOT NULL AND c.completed_at < now() - make_interval(mins => ${PEER_WAIT_MINUTES})) AS wait_over`;

/** This row and the other person's row of the same app call (linked through app_calls). */
export async function appCallRows(callId) {
  const own = await queryOne(`SELECT ${COLUMNS} FROM calls c WHERE c.id=$1`, [callId]);
  if (!own?.app_call_id || own.route !== 'app') return { own, peer: null };
  const peer = await queryOne(`SELECT ${COLUMNS} FROM app_calls a JOIN calls c ON c.id IN (a.caller_call_id, a.callee_call_id)
    WHERE a.id=$1 AND c.id<>$2 AND c.route='app' AND c.app_call_id=a.id`, [own.app_call_id, own.id]);
  return { own, peer: peer ?? null };
}

/** The other person could still give this row their voice: same call, recordable, not deleted. */
export function peerCanContribute(own, peer) {
  return !!peer && peer.route === 'app' && peer.app_call_id === own.app_call_id && peer.id !== own.id
    && peer.record_enabled === true && !peer.deleted_at && hasRecordingAuthorization(peer);
}

/** The other person's own-voice file is stored and may be used for this row's notes. */
export const peerAudioReady = (own, peer) => peerCanContribute(own, peer) && !!peer.own_audio_complete_at && !!peer.audio_object_key;

async function readOwnVoice(row, signal) {
  // Through the row's own storage key: decrypted with its owner's key, never copied.
  const response = await audioStore.getAudio(row.audio_object_key, { signal });
  if (!response.ok) throw new Error(`Could not read archived recording (HTTP ${response.status})`);
  return new Blob([await response.arrayBuffer()], { type: row.own_audio_mime ?? 'application/octet-stream' });
}

/**
 * Load this row's own-voice file and, when allowed, the other person's.
 * The peer is checked again here, at the moment of reading, so a peer who
 * deleted the call or stopped recording is never read.
 */
export async function loadAppAudio(callId, signal) {
  const { own, peer } = await appCallRows(callId);
  if (!own?.own_audio_complete_at || !own.audio_object_key) throw new Error('Your recording of this call has not been received.');
  if (!hasRecordingAuthorization(own)) throw new Error('Recording was not authorized for this call.');
  const usePeer = peerAudioReady(own, peer);
  const [mine, theirs] = await Promise.all([readOwnVoice(own, signal), usePeer ? readOwnVoice(peer, signal) : null]);
  return { own: { row: own, audio: mine }, peer: usePeer ? { row: peer, audio: theirs } : null };
}

const round = seconds => Math.round(seconds * 1000) / 1000;
function shiftWords(words, by) {
  if (!by) return words;
  return words.map(word => {
    if (!Number.isFinite(word?.start)) return word;
    const start = Math.max(0, round(word.start + by));
    return { ...word, start, ...(Number.isFinite(word.end) ? { end: Math.max(start, round(word.end + by)) } : {}) };
  });
}
const side = (result, by) => result
  ? { text: result.text, words: shiftWords(result.words, by), language_code: result.raw?.language_code ?? null,
    language_probability: result.raw?.language_probability ?? null }
  : { text: '', words: [] };

/**
 * Transcribe both single-voice files and build exactly what `transcribe()`
 * returns for a two-channel phone recording, so the rest of the notes
 * pipeline needs no changes. Channels follow the phone convention, by
 * direction: outbound rows are [owner, peer], inbound rows [peer, owner].
 *
 * The peer's words move onto this owner's timeline by the difference of the
 * two recorders' start offsets (from the shared 'connected' moment).
 *
 * audio_quality: there is no signal decoder for phone formats (m4a, ogg...)
 * on the server, so it is judged from the transcripts: 'silent' when neither
 * side has any speech, otherwise 'transcribed'. A one-sided silence is left
 * to the usual two-channel transcript rule.
 */
export async function transcribeAppAudio(loaded, { signal, names } = {}) {
  const { own, peer } = loaded;
  const [mine, theirs] = await Promise.all([
    transcription.transcribeVoice(own.audio, { mime: own.row.own_audio_mime, signal, names }),
    peer ? transcription.transcribeVoice(peer.audio, { mime: peer.row.own_audio_mime, signal, names }) : null,
  ]);
  const shift = peer ? ((peer.row.own_audio_offset_ms ?? 0) - (own.row.own_audio_offset_ms ?? 0)) / 1000 : 0;
  const ownSide = side(mine, 0), peerSide = side(theirs, shift);
  const inbound = own.row.direction === 'inbound';
  const transcripts = inbound ? [peerSide, ownSide] : [ownSide, peerSide];
  const labels = inbound ? ['Caller', 'User'] : ['User', 'Caller'];
  const silent = !ownSide.text.trim() && !peerSide.text.trim();
  const primary = ownSide.text.trim() || !theirs ? ownSide : peerSide;
  return {
    text: transcription.mergeMultiChannel(transcripts, labels),
    raw: { transcripts, audio_quality: { version: 1, basis: 'transcript', status: silent ? 'silent' : 'transcribed' } },
    language: primary.language_code ?? null,
    languageProbability: primary.language_probability ?? null,
    partial: !peer,
  };
}
