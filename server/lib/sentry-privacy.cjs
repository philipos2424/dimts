// Shared by the server and Expo. Rebuild events from metadata, rather than
// blacklisting keys: provider errors can echo a transcript in ANY string.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isUuid = value => typeof value === 'string' && UUID.test(value);
const STAGES = new Set(['server', 'app', 'recording_start', 'recording_wait',
  'recording_fetch', 'recording_lookup', 'archive', 'archive_remove', 'transcription',
  'quality', 'summary', 'persist', 'identify', 'consistency', 'processing_timeout', 'processing', 'originate', 'call']);
const CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'URIError', 'EvalError', 'AbortError', 'TimeoutError', 'APIError', 'APIConnectionError',
  'APIConnectionTimeoutError', 'RateLimitError', 'AuthenticationError', 'InternalServerError']);
const MESSAGES = new Set(['Processing ownership changed', 'Transcription returned no speech',
  'Ollama returned invalid JSON', 'Stored audio size does not match', 'Invalid recording receipt',
  'Recording did not arrive', 'Processing lease expired', 'Call failed', 'Call timed out']);

function safeMessage(value) {
  if (typeof value !== 'string') return '[redacted]';
  if (MESSAGES.has(value)) return value;
  // Keep only a known provider + HTTP status; discard the entire response tail.
  const http = /^(Could not download recording|Could not read archived recording|Audio upload failed|Audio check failed|Ollama request failed|ElevenLabs request failed|Local Whisper failed) \(HTTP ([1-5][0-9]{2})\)(?::[\s\S]*)?$/.exec(value);
  return http ? `${http[1]} (HTTP ${http[2]})` : '[redacted]';
}

function beforeSend(event) {
  const tags = {};
  if (STAGES.has(event.tags?.stage)) tags.stage = event.tags.stage;
  if (['telnyx', 'twilio'].includes(event.tags?.carrier)) tags.carrier = event.tags.carrier;
  if (isUuid(event.tags?.call_id)) tags.call_id = event.tags.call_id;
  const clean = { level: 'error', tags };
  if (typeof event.event_id === 'string' && /^[a-f0-9]{32}$/i.test(event.event_id)) clean.event_id = event.event_id;
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) clean.timestamp = event.timestamp;
  if (isUuid(event.user?.id)) clean.user = { id: event.user.id };
  if (Array.isArray(event.exception?.values) && event.exception.values.length) {
    clean.exception = { values: event.exception.values.slice(0, 5).map(value => ({
      type: CLASSES.has(value?.type) ? value.type : 'Error',
      value: safeMessage(value?.value),
    })) };
  } else clean.message = safeMessage(event.message);
  // No request, contexts, extras, breadcrumbs, logentry, stack locals/source,
  // arbitrary tags, URLs or original exception data leave this boundary.
  return clean;
}

function isEuDsn(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^o\d+\.ingest\.de\.sentry\.io$/.test(url.hostname)
      && /^[a-f0-9]+$/i.test(url.username) && !url.password && !url.port
      && /^\/\d+$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

module.exports = { beforeSend, safeMessage, isEuDsn };
