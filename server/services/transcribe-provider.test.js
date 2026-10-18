import test from 'node:test';
import assert from 'node:assert/strict';
import { scribeRetryDelayMs, transcribe } from './transcribe.js';

test('provider rejection does not expose its response body', async t => {
  const previous = { provider: process.env.TRANSCRIBE_PROVIDER, key: process.env.ELEVENLABS_API_KEY };
  process.env.TRANSCRIBE_PROVIDER = 'elevenlabs';
  process.env.ELEVENLABS_API_KEY = 'synthetic-test-key';
  t.after(() => {
    for (const [name, value] of [['TRANSCRIBE_PROVIDER', previous.provider], ['ELEVENLABS_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  let uploadedName;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    uploadedName = options.body.get('file').name;
    return new Response('private-provider-body', { status: 401 });
  });
  await assert.rejects(transcribe(new Blob(['audio'], { type: 'audio/wav' })), error => {
    assert.equal(error.message, 'ElevenLabs request failed (HTTP 401)');
    return true;
  });
  assert.equal(uploadedName, 'recording.wav');
});

function useScribe(t) {
  const previous = { provider: process.env.TRANSCRIBE_PROVIDER, key: process.env.ELEVENLABS_API_KEY };
  process.env.TRANSCRIBE_PROVIDER = 'elevenlabs';
  process.env.ELEVENLABS_API_KEY = 'synthetic-test-key';
  t.after(() => {
    for (const [name, value] of [['TRANSCRIBE_PROVIDER', previous.provider], ['ELEVENLABS_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

const okBody = () => new Response(JSON.stringify({ text: 'hello', language_code: 'en' }), { status: 200 });
const audio = () => new Blob(['audio'], { type: 'audio/wav' });

test('a transient rate limit or 5xx is retried and the call still gets notes', async t => {
  useScribe(t);
  const replies = [new Response('', { status: 429, headers: { 'retry-after': '2' } }), new Response('', { status: 503 }), okBody()];
  const bodies = new Set();
  t.mock.method(globalThis, 'fetch', async (_url, options) => { bodies.add(options.body); return replies.shift(); });
  const waits = [];
  const result = await transcribe(audio(), { retryWait: async ms => { waits.push(ms); } });
  assert.equal(result.text, 'hello');
  assert.deepEqual(waits, [2000, 3000]);
  assert.equal(bodies.size, 3, 'each attempt sends a fresh upload body');
});

test('a dropped connection is retried', async t => {
  useScribe(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return okBody();
  });
  const result = await transcribe(audio(), { retryWait: async () => {} });
  assert.equal(result.text, 'hello');
  assert.equal(calls, 2);
});

test('gives up after three attempts and reports the last status', async t => {
  useScribe(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('', { status: 502 }); });
  await assert.rejects(transcribe(audio(), { retryWait: async () => {} }), /HTTP 502/);
  assert.equal(calls, 3);
});

test('permanent rejections are not retried', async t => {
  useScribe(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('', { status: 401 }); });
  await assert.rejects(transcribe(audio(), { retryWait: async () => {} }), /HTTP 401/);
  assert.equal(calls, 1);
});

test('the processing deadline stops retries instead of waiting them out', async t => {
  useScribe(t);
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('', { status: 503 }); });
  const retryWait = async () => { controller.abort(new Error('deadline')); controller.signal.throwIfAborted(); };
  await assert.rejects(transcribe(audio(), { signal: controller.signal, retryWait }), /deadline/);
  assert.equal(calls, 1);
});

test('retry delays honour Retry-After but never wait past ten seconds', () => {
  assert.equal(scribeRetryDelayMs(1), 1000);
  assert.equal(scribeRetryDelayMs(2), 3000);
  assert.equal(scribeRetryDelayMs(1, '4'), 4000);
  assert.equal(scribeRetryDelayMs(1, '600'), 10_000);
  assert.equal(scribeRetryDelayMs(2, 'Wed, 21 Oct 2026 07:28:00 GMT'), 3000);
});

test('EU residency and zero retention are switched on by environment', async t => {
  const names = ['TRANSCRIBE_PROVIDER', 'ELEVENLABS_API_KEY', 'ELEVENLABS_BASE_URL', 'ELEVENLABS_ZERO_RETENTION'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { TRANSCRIBE_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'synthetic-test-key',
    ELEVENLABS_BASE_URL: 'https://api.eu.residency.elevenlabs.io/', ELEVENLABS_ZERO_RETENTION: 'true' });
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  let called;
  t.mock.method(globalThis, 'fetch', async url => { called = String(url); return new Response('', { status: 401 }); });
  await assert.rejects(transcribe(new Blob(['audio'], { type: 'audio/wav' })));
  assert.equal(called, 'https://api.eu.residency.elevenlabs.io/v1/speech-to-text?enable_logging=false');
});
