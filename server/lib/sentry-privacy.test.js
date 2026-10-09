import test from 'node:test';
import assert from 'node:assert/strict';
import { beforeSend, isEuDsn } from './sentry-privacy.cjs';
import * as Sentry from '@sentry/node';

const callId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const secret = 'PRIVATE_CALL_CONTENT +251911234567 https://audio.example/private.mp3?token=SECRET';
const dirty = () => ({
  event_id: 'a'.repeat(32), timestamp: 123,
  request: { data: { transcript: secret, summary: secret }, headers: { authorization: secret }, url: secret },
  phone: secret, transcript: secret, summary: secret, audio_url: secret,
  user: { id: userId, email: secret, ip_address: secret, username: secret, phone: secret },
  tags: { stage: 'transcription', carrier: 'telnyx', call_id: callId, phone: secret, transcript: secret },
  extra: { nested: { content: secret } }, contexts: { call: { summary: secret } },
  breadcrumbs: [{ message: secret, data: { url: secret } }],
  message: secret, logentry: { formatted: secret }, transaction: secret, fingerprint: [secret],
  exception: { values: [{ type: 'TypeError', value: secret, mechanism: { data: { content: secret } },
    stacktrace: { frames: [{ filename: secret, vars: { transcript: secret }, context_line: secret }] } }] },
});

test('beforeSend strips all call content, bodies, phones, audio URLs and arbitrary nested fields', () => {
  const input = dirty();
  const clean = beforeSend(input);
  assert.deepEqual(clean, {
    event_id: 'a'.repeat(32), timestamp: 123, level: 'error',
    tags: { stage: 'transcription', carrier: 'telnyx', call_id: callId }, user: { id: userId },
    exception: { values: [{ type: 'TypeError', value: '[redacted]',
      stacktrace: { frames: [{ filename: '[redacted]' }] } }] },
  });
  assert.equal(input.request.data.transcript, secret, 'do not mutate input');
  assert.deepEqual(beforeSend(clean), clean, 'filter is idempotent');
});

test('provider response tails and malicious metadata never survive the allowlist', () => {
  const input = dirty();
  input.exception.values[0].value = `ElevenLabs request failed (HTTP 429): ${secret}`;
  assert.equal(beforeSend(input).exception.values[0].value, 'ElevenLabs request failed (HTTP 429)');
  input.tags = { stage: secret, carrier: secret, call_id: '+251911234567' };
  input.user.id = secret;
  input.exception.values[0].type = secret;
  input.exception.values[0].value = `Transcription returned no speech ${secret}`;
  assert.deepEqual(beforeSend(input).tags, {});
  assert.equal(beforeSend(input).user, undefined);
  assert.deepEqual(beforeSend(input).exception.values, [{ type: 'Error', value: '[redacted]',
    stacktrace: { frames: [{ filename: '[redacted]' }] } }]);
  assert.deepEqual(beforeSend({ message: secret }), { level: 'error', tags: {}, message: '[redacted]' });
});

const withFrames = frames => ({ exception: { values: [{ type: 'Error', value: secret, stacktrace: { frames } }] } });
const cleanedFrames = frames => beforeSend(withFrames(frames)).exception.values[0].stacktrace.frames;

test('frames retain only bounded source locations and strip machine paths and source context', () => {
  const input = withFrames([{
    filename: 'C:\\Users\\Private Person\\dimts\\server\\lib\\calls.js?token=SECRET#private',
    function: 'Calls.process', lineno: 42, colno: 0, in_app: true,
    vars: { secret }, context_line: secret, pre_context: [secret], post_context: [secret],
    module_metadata: { secret }, abs_path: secret, module: secret, debug_id: secret,
  }]);
  const original = structuredClone(input);
  const clean = beforeSend(input);
  assert.deepEqual(clean.exception.values[0].stacktrace.frames, [
    { filename: 'server/lib/calls.js', function: 'Calls.process', lineno: 42, colno: 0, in_app: true },
  ]);
  assert.equal(clean.exception.values[0].value, '[redacted]');
  assert.deepEqual(input, original);
  assert.deepEqual(beforeSend(clean), clean);
  for (const [filename, expected] of [
    ['/var/task/server/lib/calls.js', 'server/lib/calls.js'],
    ['file:///var/task/node_modules/@sentry/node/build/index.js', 'node_modules/@sentry/node/build/index.js'],
    ['file:///C:/Users/Private/dimts/src/sentry.ts', 'src/sentry.ts'],
    ['app/(tabs)/[id].tsx', 'app/(tabs)/[id].tsx'],
    ['app:///entry.js?token=SECRET', 'app:///entry.js'],
    ['index.android.bundle', 'app:///index.android.bundle'],
    ['main.jsbundle', 'app:///main.jsbundle'],
    ['index.hbc', 'app:///index.hbc'],
    ['_expo/static/js/web/entry-012abc.js', 'app:///_expo/static/js/web/entry-012abc.js'],
  ]) assert.equal(cleanedFrames([{ filename }])[0].filename, expected, filename);
});

test('hostile filenames, function names and malformed frame fields cannot escape', () => {
  for (const filename of [secret, 'https://evil.test/server/secret.js', 'data:text/javascript,secret',
    'eval at run (server/calls.js)', 'app:///../private.js', 'src/../../private.js',
    'src/%2e%2e/private.js', 'src/private content.js', 'src/calls.js\nSECRET',
    'node_modules/private.js', 'private.txt', `src/${'x'.repeat(240)}.js`, 'x'.repeat(2049)]) {
    assert.equal(cleanedFrames([{ filename }])[0].filename, '[redacted]', filename);
  }
  for (const name of [secret, 'eval', 'Object.eval', 'sourceURL', 'anonymous.SECRET',
    '<anonymous>:SECRET', 'run (private)', 'a'.repeat(81), null, 42]) {
    assert.deepEqual(cleanedFrames([{ filename: 'src/sentry.ts', function: name,
      lineno: '42', colno: Infinity, in_app: secret }]), [{ filename: 'src/sentry.ts' }]);
  }
  assert.deepEqual(cleanedFrames([null, {}, { lineno: -1, colno: 1.5 }]),
    Array.from({ length: 3 }, () => ({ filename: '[redacted]' })));
  assert.equal(cleanedFrames([{ function: 'a'.repeat(80) }])[0].function.length, 80);
});

test('the 50 frame budget keeps the throw site and also bounds chained and top-level stacks', () => {
  const frames = Array.from({ length: 75 }, (_, lineno) => ({ filename: 'server/lib/calls.js', lineno }));
  const input = withFrames(frames);
  input.exception.values.push(...withFrames(frames).exception.values);
  input.stacktrace = { frames };
  const clean = beforeSend(input);
  const kept = clean.exception.values[0].stacktrace.frames;
  assert.equal(kept.length, 50);
  assert.equal(kept[0].lineno, 25);
  assert.equal(kept[49].lineno, 74);
  assert.equal(clean.exception.values[1].stacktrace, undefined);
  assert.equal(clean.stacktrace, undefined);
});

test('only matching sourcemap images with UUID Debug IDs survive', () => {
  const filename = 'file:///var/task/server/lib/calls.js?token=SECRET';
  const input = withFrames([{ filename, lineno: 1, colno: 1234 }]);
  const valid = { type: 'sourcemap', code_file: filename, debug_id: callId, debug_file: secret, extra: secret };
  input.debug_id = callId;
  input.debug_meta = { secret, images: [valid, null,
    { ...valid, debug_id: secret }, { ...valid, type: 'elf' },
    { ...valid, code_file: 'src/unreferenced.js' }, { ...valid, code_file: secret }] };
  const clean = beforeSend(input);
  assert.deepEqual(clean.debug_meta, { images: [
    { type: 'sourcemap', code_file: 'server/lib/calls.js', debug_id: callId },
  ] });
  assert.equal(clean.debug_id, callId);
  assert.equal(clean.debug_meta.images[0].code_file, clean.exception.values[0].stacktrace.frames[0].filename);
  assert.deepEqual(beforeSend(clean), clean);
  assert.doesNotMatch(JSON.stringify(clean), /SECRET|private|var\/task/);
  input.debug_id = secret;
  input.debug_meta.images = Array(75).fill(valid);
  assert.equal(beforeSend(input).debug_meta.images.length, 50);
  assert.equal(beforeSend(input).debug_id, undefined);
});

test('EU DSNs are validated without allowing US hosts, credentials, queries or lookalike domains', () => {
  assert.equal(isEuDsn('https://abcdef@o123.ingest.de.sentry.io/456'), true);
  for (const dsn of ['', 'invalid', 'https://abcdef@o123.ingest.us.sentry.io/456',
    'https://abcdef@o123.ingest.de.sentry.io.evil.test/456',
    'http://abcdef@o123.ingest.de.sentry.io/456', 'https://abcdef:secret@o123.ingest.de.sentry.io/456',
    'https://abcdef@o123.ingest.de.sentry.io/456?url=private']) assert.equal(isEuDsn(dsn), false);
});

test('the real SDK transport receives only the sanitized error envelope, with no network', async () => {
  const envelopes = [];
  Sentry.init({ dsn: 'https://abcdef@o123.ingest.de.sentry.io/456', defaultIntegrations: false,
    sendDefaultPii: false, sendClientReports: false, beforeSend,
    transport: () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }),
  });
  try {
    const event = dirty();
    event.exception.values[0].stacktrace.frames.push({
      filename: '/var/task/server/lib/calls.js?token=SECRET', function: 'processCall', lineno: 42, colno: 3,
    });
    event.debug_meta = { images: [{ type: 'sourcemap',
      code_file: '/var/task/server/lib/calls.js?token=SECRET', debug_id: userId }] };
    Sentry.captureEvent(event);
    await Sentry.flush(1000);
    assert.equal(envelopes.length, 1);
    const serialized = JSON.stringify(envelopes);
    assert.doesNotMatch(serialized, /PRIVATE_CALL_CONTENT|251911234567|audio\.example|SECRET/);
    assert.match(serialized, /transcription/);
    assert.match(serialized, new RegExp(callId));
    const payload = envelopes[0][1].find(([header]) => header.type === 'event')[1];
    assert.deepEqual(payload.exception.values[0].stacktrace.frames[1], {
      filename: 'server/lib/calls.js', function: 'processCall', lineno: 42, colno: 3,
    });
    assert.deepEqual(payload.debug_meta.images, [{ type: 'sourcemap', code_file: 'server/lib/calls.js', debug_id: userId }]);
  } finally { await Sentry.close(1000); }
});
