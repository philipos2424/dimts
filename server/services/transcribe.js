import { config } from '../config.js';

// ELEVENLABS_BASE_URL=https://api.eu.residency.elevenlabs.io keeps audio in
// the EU and ELEVENLABS_ZERO_RETENTION=true stops ElevenLabs keeping it; both
// need an ElevenLabs Enterprise plan, so neither is the default.
function endpoint() {
  const base = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  return `${base}/v1/speech-to-text${process.env.ELEVENLABS_ZERO_RETENTION === 'true' ? '?enable_logging=false' : ''}`;
}

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

export const BASE_KEYTERMS = ['Dimts'];
// Words general models mishear on calls with Ethiopia (birr came back as
// "dirham" on the first Ethiopian test call). Only sent when a +251 number
// is on the call, so other calls are not nudged toward them.
export const ETHIOPIA_KEYTERMS = ['birr', 'Ethiopian birr', 'ብር', 'santim', 'Addis Ababa'];

/** Usable keyterms: ElevenLabs takes under 50 characters, at most 5 words, none of <>{}[]\. */
export function keytermsFor(names = [], phones = []) {
  const ethiopia = phones.some(p => typeof p === 'string' && p.startsWith('+251'));
  const clean = [...BASE_KEYTERMS, ...(ethiopia ? ETHIOPIA_KEYTERMS : []), ...names]
    .filter(t => typeof t === 'string').map(t => t.trim().replace(/\s+/g, ' '))
    .filter(t => t && t.length < 50 && t.split(' ').length <= 5 && !/[<>{}[\]\\]/.test(t));
  return [...new Set(clean)].slice(0, 100);
}

// A rate limit, a 5xx or a dropped connection is usually gone a few seconds
// later. Without a retry one blip costs the call its notes until the owner
// retries by hand. Other 4xx answers (bad key, bad audio) will not change.
export const SCRIBE_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;

/** Wait before attempt `attempt + 1`: Retry-After when given (capped), else 1s, 3s. */
export function scribeRetryDelayMs(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (retryAfter != null && retryAfter !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return attempt === 1 ? 1000 : 3000;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal.reason); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function callScribe(audio, fields, signal, keyterms = [], { wait = sleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    // FormData is rebuilt per attempt so a retry never resends a consumed body.
    const form = new FormData();
    form.set('file', audio, audio.type === 'audio/wav' ? 'recording.wav' : 'recording.mp3');
    form.set('model_id', config.scribeModelId);
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, String(value));
    }
    // ElevenLabs reads a list as the same field repeated, not as JSON.
    for (const term of keyterms) form.append('keyterms', term);

    let response;
    try {
      response = await fetch(endpoint(), {
        method: 'POST',
        headers: { 'xi-api-key': config.elevenLabsApiKey },
        body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
    } catch (err) {
      // The caller's own deadline is final; only a network error or this
      // attempt's timeout is worth another try.
      if (signal?.aborted || attempt >= SCRIBE_ATTEMPTS) throw err;
      console.warn(`[scribe] attempt ${attempt} failed (${err?.name ?? 'error'}); retrying`);
      await wait(scribeRetryDelayMs(attempt), signal);
      continue;
    }

    if (!RETRYABLE_STATUS.has(response.status) || attempt >= SCRIBE_ATTEMPTS) return response;
    console.warn(`[scribe] attempt ${attempt} got HTTP ${response.status}; retrying`);
    await response.body?.cancel().catch(() => {});
    await wait(scribeRetryDelayMs(attempt, response.headers.get('retry-after')), signal);
  }
}

/**
 * Transcribe a dual-channel recording.
 *
 * Each speaker is separated by recording channel. A one-channel recording is
 * transcribed without speaker labels: diarization tells voices apart, which
 * US biometric-privacy suits (BIPA) treat as a voiceprint, and the notes
 * pipeline does not use its labels anyway.
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
  const channels = mp3Channels(new Uint8Array(await audioBlob.slice(0, 128 * 1024).arrayBuffer()));
  if (channels === 1 && !options.voicemail) console.warn('[scribe] recording is mono; transcribing without speaker labels');
  const multi = !options.voicemail && channels !== 1;
  const keyterms = keytermsFor(options.names, options.phones);
  const retry = { wait: options.retryWait };
  let response = await callScribe(audioBlob, multi ? { use_multi_channel: true } : {}, options.signal, keyterms, retry);

  if (response.status === 400 && multi) {
    const first = await scribeError(response);
    console.warn('[scribe] multichannel rejected, retrying as one channel:', first.message);
    response = await callScribe(audioBlob, {}, options.signal, keyterms, retry);
  }

  if (!response.ok) throw await scribeError(response);

  return normalizeScribeResponse(await response.json(), options);
}
