import { adoptExtractedName, touchLastCall } from '../db/contacts.js';
import { query, queryOne } from '../db/pool.js';
import { shouldAdoptName } from '../lib/contact-policy.js';
import { identifyCaller } from './identify.js';
import { fetchRecording } from './originate.js';
import { transcribe } from './transcribe.js';
import { summarize } from './summarize.js';
import { randomUUID } from 'node:crypto';
import { recordingQualityError } from '../lib/recording-quality.js';

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
 * An atomic lease prevents duplicate webhook deliveries from buying duplicate
 * transcriptions. Expired leases can be reclaimed after a worker dies.
 * Any failure is recorded on the row so
 * the app can show why rather than spinning on 'processing' forever.
 */
export async function processRecording(callId, { force = false } = {}) {
  const lease = randomUUID();
  const call = await queryOne(
    `WITH claimed AS (
       UPDATE calls SET processing_token = $2,
         processing_until = now() + interval '10 minutes', processing_requested_at=now(),status = 'processing'
       WHERE id = $1 AND recording_url IS NOT NULL
         AND (status <> 'ready' OR $3)
         AND (processing_until IS NULL OR processing_until < now())
       RETURNING *
     )
     SELECT c.id, c.recording_url, c.contact_id, c.direction,c.transcript,c.transcript_data,
            c.transcript_recording_url,c.language,c.language_probability,
            k.display_name  AS contact_display_name,
            k.name_source   AS contact_name_source,
            k.name_confidence AS contact_name_confidence
       FROM claimed c
       LEFT JOIN contacts k ON k.id = c.contact_id
      WHERE c.id = $1`,
    [callId, lease, force]
  );

  if (!call?.recording_url) {
    return { status: 'skipped' };
  }

  try {
    async function renew() {
      const owned = await queryOne(`UPDATE calls SET processing_until=now()+interval '10 minutes'
        WHERE id=$1 AND processing_token=$2 AND status='processing' RETURNING id`, [callId, lease]);
      if (!owned) throw new Error('Processing ownership changed');
    }
    let result;
    if (!force && call.transcript_recording_url === call.recording_url && call.transcript?.trim()) {
      result = { text: call.transcript, raw: call.transcript_data,
        language: call.language, languageProbability: call.language_probability };
    } else {
      const audio = await downloadRecording(call.recording_url);
      await renew();
      result = await transcribe(audio, { direction: call.direction });
      const saved = await queryOne(`UPDATE calls SET transcript=$3,transcript_data=$4,
        language=$5,language_probability=$6,transcript_recording_url=$7,
        processing_until=now()+interval '10 minutes'
        WHERE id=$1 AND processing_token=$2 AND status='processing' RETURNING id`,
        [callId, lease, result.text, JSON.stringify(result.raw), result.language, result.languageProbability, call.recording_url]);
      if (!saved) throw new Error('Processing ownership changed');
    }

    const qualityError = recordingQualityError(result.raw);
    if (qualityError) throw new Error(qualityError);
    if (!result.text.trim()) {
      throw new Error('Transcription returned no speech');
    }

    await renew();
    const summary = await summarize(result.text);

    const saved = await query(
      `UPDATE calls
          SET transcript = $2,
              transcript_data = $3,
              summary = $4,
              next_moves = $5,
              action_items = $6,
              key_points = $7,
              error = NULL,
              language = $8,
              language_probability = $9,
              processing_token = NULL,
              processing_until = NULL,
              status = 'ready'
        WHERE id = $1 AND processing_token = $10 RETURNING id`,
      [
        callId,
        result.text,
        JSON.stringify(result.raw),
        summary.summary,
        JSON.stringify(summary.next_moves),
        JSON.stringify(summary.action_items),
        JSON.stringify(summary.key_points),
        result.language,
        result.languageProbability,
        lease,
      ]
    );
    // Only the worker that committed the notes may spend on identification or
    // update a contact. A stale worker cannot apply its old result.
    if (saved.rows.length) await nameContact(call, result.text);
  } catch (err) {
    await query(
      `UPDATE calls SET status = 'failed', error = $2,
        processing_token = NULL, processing_until = NULL
       WHERE id = $1 AND processing_token = $3`,
      [callId, String(err?.message ?? err).slice(0, 500), lease]
    );
    throw err;
  }
}
