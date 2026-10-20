import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeVoice } from './transcribe.js';

// transcribeVoice: one person's own-voice file (app calls), on the same
// provider request, retries and keyterms as transcribe().
function useProvider(t, provider) {
  const previous = { provider: process.env.TRANSCRIBE_PROVIDER, key: process.env.ELEVENLABS_API_KEY };
  process.env.TRANSCRIBE_PROVIDER = provider;
  process.env.ELEVENLABS_API_KEY = 'synthetic-test-key';
  t.after(() => {
    for (const [name, value] of [['TRANSCRIBE_PROVIDER', previous.provider], ['ELEVENLABS_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}
const words = [{ text: 'Hello', type: 'word', start: 0.1, end: 0.4 }, { text: ' ', type: 'spacing', start: 0.4, end: 0.5 }];

test('one channel, no diarization, the file named for its format, keyterms sent', async t => {
  useProvider(t, 'elevenlabs');
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const file = options.body.get('file');
    sent.push({ url: String(url), name: file.name, type: file.type, multi: options.body.get('use_multi_channel'),
      diarize: options.body.get('diarize'), keyterms: options.body.getAll('keyterms') });
    return Response.json({ text: ' Hello ', words, language_code: 'en', language_probability: 0.8 });
  });
  const result = await transcribeVoice(new Blob(['a']), { mime: 'audio/x-m4a', names: ['Sara Bekele'] });
  assert.deepEqual(result, { text: 'Hello', words, raw: { text: ' Hello ', words, language_code: 'en', language_probability: 0.8 } });
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/v1\/speech-to-text/);
  assert.equal(sent[0].name, 'recording.m4a');
  assert.equal(sent[0].type, 'audio/x-m4a');
  assert.equal(sent[0].multi, null);
  assert.equal(sent[0].diarize, null);
  assert.deepEqual(sent[0].keyterms, ['Dimts', 'Sara Bekele']);
  for (const [mime, name] of [['audio/ogg', 'recording.ogg'], ['audio/webm', 'recording.webm'], ['audio/aac', 'recording.aac'], ['audio/mpeg', 'recording.mp3']]) {
    await transcribeVoice(new Blob(['a']), { mime });
    assert.equal(sent.at(-1).name, name, mime);
  }
});

test('the same retries as phone calls: a rate limit is retried, then a refusal is plain', async t => {
  useProvider(t, 'elevenlabs');
  let calls = 0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return calls === 1 ? new Response('busy', { status: 429 }) : Response.json({ text: 'ok', words: [] });
  });
  const waits = [];
  const ok = await transcribeVoice(new Blob(['a']), { mime: 'audio/mp4', retryWait: async ms => { waits.push(ms); } });
  assert.equal(ok.text, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
  t.mock.method(globalThis, 'fetch', async () => new Response('private-provider-body', { status: 401 }));
  t.mock.method(console, 'error', () => {});
  await assert.rejects(transcribeVoice(new Blob(['a']), { mime: 'audio/mp4' }), e => e.message === 'ElevenLabs request failed (HTTP 401)');
});

test('the local Whisper provider is used the same way and its single result is unwrapped', async t => {
  useProvider(t, 'whisper');
  const token = process.env.WHISPER_API_TOKEN;
  process.env.WHISPER_API_TOKEN = 'synthetic-whisper-token';
  t.after(() => { if (token === undefined) delete process.env.WHISPER_API_TOKEN; else process.env.WHISPER_API_TOKEN = token; });
  let name;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    name = options.body.get('file').name;
    assert.match(String(url), /\/transcribe$/);
    return Response.json({ text: 'hi', words, language_code: 'en' });
  });
  const result = await transcribeVoice(new Blob(['a']), { mime: 'audio/wav' });
  assert.equal(result.text, 'hi');
  assert.equal(name, 'recording.wav');
});
