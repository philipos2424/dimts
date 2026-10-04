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
export function normalizeScribeResponse(data, { direction = 'outbound', voicemail = false } = {}) {
  if (voicemail) {
    const single = Array.isArray(data?.transcripts) ? data.transcripts[0] : data;
    const text = (single?.text ?? '').trim();
    return { text: text ? `Caller: ${text}` : '', language: single?.language_code ?? null,
      languageProbability: single?.language_probability ?? null, raw: data };
  }
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

/**
 * Channel count from the first MP3 frame header (skipping an ID3 tag), or null
 * when the bytes are not a recognisable MP3. Channel mode 3 means mono.
 */
export function mp3Channels(bytes) {
  let i = 0;
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    i = 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
  }
  for (const end = Math.min(bytes.length - 4, i + 64 * 1024); i <= end; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0 && (bytes[i + 1] & 0x06) !== 0) {
      return ((bytes[i + 3] >> 6) & 0x03) === 3 ? 1 : 2;
    }
  }
  return null;
}

// ElevenLabs explains a refusal in `detail`; keep it short and plain so the
// call screen and logs say why, without echoing anything unexpected.
async function scribeError(response) {
  let detail = '';
  try {
    const body = await response.json();
    const d = body?.detail;
    detail = typeof d === 'string' ? d : d?.message ?? d?.status ?? '';
  } catch { /* not JSON */ }
  detail = String(detail).replace(/[^\p{L}\p{N} .,:;'()_\-/]/gu, '').slice(0, 160);
  console.error('[scribe] request failed', response.status, detail);
  return new Error(`ElevenLabs request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
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
  // A one-channel file cannot be split by channel; ask for speaker labels instead.
  const channels = mp3Channels(new Uint8Array(await audioBlob.slice(0, 128 * 1024).arrayBuffer()));
  if (channels === 1 && !options.voicemail) console.warn('[scribe] recording is mono; using diarize');
  const multi = !options.voicemail && channels !== 1;
  let response = await callScribe(audioBlob, options.voicemail ? {} : multi ? { use_multi_channel: true } : { diarize: true }, options.signal);

  if (response.status === 400 && multi) {
    const first = await scribeError(response);
    console.warn('[scribe] multichannel rejected, retrying with diarize:', first.message);
    response = await callScribe(audioBlob, { diarize: true }, options.signal);
  }

  if (!response.ok) throw await scribeError(response);

  return normalizeScribeResponse(await response.json(), options);
}
