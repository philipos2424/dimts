import { adoptExtractedName, touchLastCall } from '../db/contacts.js';
import { query, queryOne } from '../db/pool.js';
import { shouldAdoptName } from '../lib/contact-policy.js';
import { identifyCaller } from './identify.js';
import { fetchRecording } from './originate.js';
import { transcribe } from './transcribe.js';
import { summarize } from './summarize.js';

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Twilio occasionally 404s the media for a second or two after the
 * recording-ready webhook fires, before the file is durably stored.
 */
async function downloadRecording(recordingUrl) {
  let lastStatus;

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const response = await fetchRecording(recordingUrl);
    if (response.ok) return response.blob();

    lastStatus = response.status;
    if (response.status !== 404) break;
    if (attempt < DOWNLOAD_ATTEMPTS) await sleep(DOWNLOAD_BACKOFF_MS * attempt);
  }

  throw new Error(`Could not download recording (HTTP ${lastStatus})`);
}

/**
 * Name the contact from the conversation.
 *
 * Best-effort by design: a call whose notes are perfectly good should not be
 * marked failed because the identification model was unavailable.
 */
async function nameContact(call, transcript) {
  if (!call.contact_id) return;

  try {
    await touchLastCall(call.contact_id);

    const identity = await identifyCaller(transcript);
    const existing = {
      display_name: call.contact_display_name,
      name_source: call.contact_name_source,
      name_confidence: call.contact_name_confidence,
    };

    if (shouldAdoptName(existing, identity)) {
      await adoptExtractedName(call.contact_id, identity);
    }
  } catch (err) {
    console.error('[identify] naming failed for call', call.id, err);
  }
}

/**
 * Download -> transcribe -> summarize -> mark ready.
 *
 * Idempotent: safe to re-run for a stuck row, which is what
 * POST /api/calls/:id/process relies on. Any failure is recorded on the row so
 * the app can show why rather than spinning on 'processing' forever.
 */
export async function processRecording(callId) {
  const call = await queryOne(
    `SELECT c.id, c.recording_url, c.contact_id,
            k.display_name  AS contact_display_name,
            k.name_source   AS contact_name_source,
            k.name_confidence AS contact_name_confidence
       FROM calls c
       LEFT JOIN contacts k ON k.id = c.contact_id
      WHERE c.id = $1`,
    [callId]
  );

  if (!call?.recording_url) {
    throw new Error(`Call ${callId} has no recording to process`);
  }

  try {
    const audio = await downloadRecording(call.recording_url);
    const result = await transcribe(audio);

    if (!result.text.trim()) {
      throw new Error('Transcription returned no speech');
    }

    const summary = await summarize(result.text);

    await nameContact(call, result.text);

    await query(
      `UPDATE calls
          SET transcript = $2,
              transcript_data = $3,
              summary = $4,
              next_moves = $5,
              action_items = $6,
              key_points = $7,
              error = NULL,
              status = 'ready'
        WHERE id = $1`,
      [
        callId,
        result.text,
        JSON.stringify(result.raw),
        summary.summary,
        JSON.stringify(summary.next_moves),
        JSON.stringify(summary.action_items),
        JSON.stringify(summary.key_points),
      ]
    );
  } catch (err) {
    await query(
      `UPDATE calls SET status = 'failed', error = $2 WHERE id = $1`,
      [callId, String(err?.message ?? err).slice(0, 500)]
    );
    throw err;
  }
}
