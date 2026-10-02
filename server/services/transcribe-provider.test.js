import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe } from './transcribe.js';

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
