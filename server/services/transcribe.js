import { config } from '../config.js';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * Interleave a multichannel Scribe response into speaker-labelled dialogue.
 *
 * Twilio puts the parent leg on channel 0 and the dialled leg on channel 1.
 * For incoming calls the caller is the parent; for outgoing calls it is User.
 *
 * This assumes per-channel word `start` values share one timeline. If they
 * ever don't, the interleave would scramble the conversation, so
 * `sequentialTranscript` is kept as the fallback shape.
 */
export function mergeMultiChannel(transcripts, labels = ['User', 'Caller']) {
  const tokens = [];
  for (const [channel, transcript] of transcripts.entries()) {
    const speaker = labels[channel] ?? `Speaker ${channel + 1}`;
    const words = (transcript?.words ?? []).filter(
      (word) => !word.type || word.type === 'word'
    );
    for (const word of words) {
      // Never invent a timeline when a provider omits timing information.
      if (!Number.isFinite(word.start)) return sequentialTranscript(transcripts, labels);
      tokens.push({ speaker, start: word.start, text: word.text ?? '' });
    }
    if (!words.length && transcript?.text) {
      return sequentialTranscript(transcripts, labels);
    }
  }
  const turns = [];
  for (const token of tokens.sort((a, b) => a.start - b.start)) {
    const previous = turns.at(-1);
    if (previous?.speaker === token.speaker) previous.text += ` ${token.text}`;
    else turns.push({ ...token });
  }
  return turns
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
export function normalizeScribeResponse(data, { direction = 'outbound' } = {}) {
  if (Array.isArray(data?.transcripts) && data.transcripts.length > 0) {
    const primary = data.transcripts[0];
    return {
      text: mergeMultiChannel(data.transcripts,
        direction === 'inbound' ? ['Caller', 'User'] : ['User', 'Caller']),
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

async function callScribe(audio, fields, signal) {
  const form = new FormData();
  form.set('file', audio, audio.type === 'audio/wav' ? 'recording.wav' : 'recording.mp3');
  form.set('model_id', config.scribeModelId);
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, String(value));
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenLabsApiKey },
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
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
export async function transcribe(audioBlob, options = {}) {
  options.signal?.throwIfAborted();
  if (config.transcribeProvider === 'whisper') {
    const form = new FormData();
    form.set('file', audioBlob, 'recording.mp3');
    const response = await fetch(`${config.whisperBaseUrl}/transcribe`, {
      method: 'POST', body: form,
      headers: { Authorization: `Bearer ${config.whisperApiToken}` },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    });
    if (response.status === 422) throw new Error('The saved recording could not be decoded in a supported audio layout. Play or export it to check the file; AI notes were not generated.');
    if (!response.ok) throw new Error(`Local Whisper failed (HTTP ${response.status})`);
    return normalizeScribeResponse(await response.json(), options);
  }
  if (config.transcribeProvider !== 'elevenlabs') throw new Error('Unsupported TRANSCRIBE_PROVIDER');
  let response = await callScribe(audioBlob, { use_multi_channel: true }, options.signal);

  if (response.status === 400) {
    await response.body?.cancel();
    console.warn('[scribe] multichannel rejected (HTTP 400), retrying with diarize');
    response = await callScribe(audioBlob, { diarize: true }, options.signal);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ElevenLabs request failed (HTTP ${response.status})`);
  }

  return normalizeScribeResponse(await response.json(), options);
}
