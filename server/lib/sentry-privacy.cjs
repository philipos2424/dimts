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

function safeFilename(value) {
  if (typeof value !== 'string' || value.length > 2048) return '[redacted]';
  let path = value.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const canonical = path.startsWith('app:///');
  if (canonical) path = path.slice(7);
  else {
    path = path.replace(/^file:\/\//, '');
    // Only local absolute paths can have a machine prefix removed. Never
    // salvage a plausible-looking source path from a remote URL or eval text.
    if (/^(?:\/?[A-Za-z]:\/|\/)/.test(path)) {
      const root = /(?:^|\/)(server|app|src|node_modules)\//.exec(path);
      path = root ? path.slice(root.index + (path[root.index] === '/' ? 1 : 0))
        : path.slice(path.lastIndexOf('/') + 1);
    }
  }
  if (!path || path.length > 240 || !/^[A-Za-z0-9_@.$()[\]/-]+$/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) return '[redacted]';
  const bundle = /^(?:index(?:\.android|\.ios)?\.bundle|main\.jsbundle|(?:index|main|AppEntry|entry)\.hbc|_expo\/static\/js\/(?:web|ios|android)\/[A-Za-z0-9_-]+\.js)$/.test(path);
  const source = /\.(?:[cm]?js|jsx|ts|tsx)$/.test(path);
  const appPath = /^(?:server|app|src)\/.+/.test(path);
  const packagePath = /^node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+\/.+/.test(path);
  if (bundle || (source && (canonical || appPath || packagePath))) {
    return canonical || bundle ? `app:///${path}` : path;
  }
  return '[redacted]';
}

function safeFrame(frame) {
  const clean = { filename: safeFilename(frame?.filename) };
  const name = frame?.function;
  if (typeof name === 'string' && name.length <= 80 && /^[A-Za-z_$][\w$.<>]*$/.test(name)
    && !/eval|sourceURL|anonymous/i.test(name)) clean.function = name;
  for (const key of ['lineno', 'colno']) {
    if (Number.isSafeInteger(frame?.[key]) && frame[key] >= 0 && frame[key] <= 2147483647) clean[key] = frame[key];
  }
  if (typeof frame?.in_app === 'boolean') clean.in_app = frame.in_app;
  return clean;
}

function beforeSend(event) {
  let remainingFrames = 50;
  const filenames = new Set();
  const stacktrace = stack => {
    if (!Array.isArray(stack?.frames) || !stack.frames.length || !remainingFrames) return undefined;
    // Sentry orders frames oldest first: retain the frames nearest the throw.
    const frames = stack.frames.slice(-remainingFrames).map(safeFrame);
    remainingFrames -= frames.length;
    for (const frame of frames) if (frame.filename !== '[redacted]') filenames.add(frame.filename);
    return { frames };
  };
  const tags = {};
  if (STAGES.has(event.tags?.stage)) tags.stage = event.tags.stage;
  if (['telnyx', 'twilio'].includes(event.tags?.carrier)) tags.carrier = event.tags.carrier;
  if (isUuid(event.tags?.call_id)) tags.call_id = event.tags.call_id;
  const clean = { level: 'error', tags };
  if (typeof event.event_id === 'string' && /^[a-f0-9]{32}$/i.test(event.event_id)) clean.event_id = event.event_id;
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) clean.timestamp = event.timestamp;
  if (isUuid(event.user?.id)) clean.user = { id: event.user.id };
  if (Array.isArray(event.exception?.values) && event.exception.values.length) {
    clean.exception = { values: event.exception.values.slice(0, 5).map(value => {
      const exception = {
        type: CLASSES.has(value?.type) ? value.type : 'Error',
        value: safeMessage(value?.value),
      };
      const stack = stacktrace(value?.stacktrace);
      if (stack) exception.stacktrace = stack;
      return exception;
    }) };
  } else clean.message = safeMessage(event.message);
  const stack = stacktrace(event.stacktrace);
  if (stack) clean.stacktrace = stack;
  if (isUuid(event.debug_id)) clean.debug_id = event.debug_id;
  if (Array.isArray(event.debug_meta?.images)) {
    const images = event.debug_meta.images.slice(0, 50).flatMap(image => {
      const code_file = safeFilename(image?.code_file);
      // Relay derives abs_path from filename when absent. Use the identical
      // sanitizer here so that abs_path and code_file still match for Debug IDs.
      return image?.type === 'sourcemap' && isUuid(image.debug_id) && filenames.has(code_file)
        ? [{ type: 'sourcemap', code_file, debug_id: image.debug_id }] : [];
    });
    if (images.length) clean.debug_meta = { images };
  }
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
