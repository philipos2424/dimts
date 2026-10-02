import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe } from './transcribe.js';
import { completeJson } from './llm.js';

test('an expired processing deadline prevents new transcription or LLM requests', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not request'); });
  const signal = AbortSignal.abort();
  await assert.rejects(transcribe(new Blob(['audio']), { signal }), { name: 'AbortError' });
  await assert.rejects(completeJson('system', 'transcript', 'json', { signal }), { name: 'AbortError' });
  assert.equal(request.mock.callCount(), 0);
});

test('shared deadline cancels an already running Ollama request', async t => {
  const previous = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = 'ollama';
  t.after(() => { if (previous === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previous; });
  const controller = new AbortController();
  let activeSignal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    activeSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      controller.abort();
    });
  });
  await assert.rejects(completeJson('system', 'transcript', 'json', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(activeSignal.aborted, true);
});
