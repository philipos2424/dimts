import { config } from '../config.js';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * Interleave a multichannel Scribe response into speaker-labelled dialogue.
 *
 * Twilio's record-from-answer-dual puts the user on channel 0 and the
 * destination on channel 1, so channel index maps directly to speaker.
 *
 * This assumes per-channel word `start` values share one timeline. If they
 * ever don't, the interleave would scramble the conversation, so
 * `sequentialTranscript` is kept as the fallback shape.
 */
export function mergeMultiChannel(transcripts, labels = ['User', 'Caller']) {
  const turns = [];

  for (const [channel, transcript] of transcripts.entries()) {
    const speaker = labels[channel] ?? `Speaker ${channel + 1}`;
    const words = transcript?.words ?? [];

    let current = null;
    for (const word of words) {
      // Scribe emits spacing/audio-event tokens alongside words; only `word`
      // entries carry content worth attributing to a speaker.
      if (word.type && word.type !== 'word') {
        if (current) current.text += word.text ?? ' ';
        continue;
      }
      if (!current) {
        current = { speaker, start: word.start ?? 0, text: word.text ?? '' };
      } else {
        current.text += ` ${word.text ?? ''}`;
      }
    }
    if (current) turns.push(current);

    // No word-level timings: fall back to the channel's whole text as one turn.
    if (!current && transcript?.text) {
      turns.push({ speaker, start: 0, text: transcript.text });
    }
  }

  return turns
    .sort((a, b) => a.start - b.start)
    .map((turn) => `${turn.speaker}: ${turn.text.trim().replace(/\s+/g, ' ')}`)
    .join('\n');
}

/** Used when channels cannot be safely interleaved. */
export function sequentialTranscript(transcripts, labels = ['User', 'Caller']) {
  return transcripts
    .map((t, i) => `${labels[i] ?? `Speaker ${i + 1}`}: ${(t?.text ?? '').trim()}`)
    .filter((line) => !line.endsWith(': '))
    .join('\n');
}

/**
 * Normalize both Scribe response shapes.
 *
 * Multichannel returns `transcripts[]`; single-channel returns the same fields
 * at the top level. Callers should not have to care which one came back.
 */
export function normalizeScribeResponse(data) {
  if (Array.isArray(data?.transcripts) && data.transcripts.length > 0) {
    const primary = data.transcripts[0];
    return {
      text: mergeMultiChannel(data.transcripts),
      language: primary?.language_code ?? null,
      languageProbability: primary?.language_probability ?? null,
      raw: data,
    };
  }

  return {
    text: data?.text ?? '',
    language: data?.language_code ?? null,
    languageProbability: data?.language_probability ?? null,
    raw: data,
  };
}

async function callScribe(audio, fields) {
  const form = new FormData();
  form.set('file', audio, 'recording.mp3');
  form.set('model_id', config.scribeModelId);
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, String(value));
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenLabsApiKey },
    body: form,
  });

  return response;
}

/**
 * Transcribe a dual-channel recording.
 *
 * Tries multichannel first so each speaker is separated by channel, which is
 * more reliable than diarization. SPEC prescribes falling back to diarize on a
 * 400 — the two options cannot be combined.
 */
export async function transcribe(audioBlob) {
  let response = await callScribe(audioBlob, { use_multi_channel: true });

  if (response.status === 400) {
    const detail = await response.text().catch(() => '');
    console.warn('[scribe] multichannel rejected, retrying with diarize:', detail);
    response = await callScribe(audioBlob, { diarize: true });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs ${response.status}: ${detail.slice(0, 500)}`);
  }

  return normalizeScribeResponse(await response.json());
}
