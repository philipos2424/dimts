import test from 'node:test';
import assert from 'node:assert/strict';
import { completeJson } from './llm.js';

test('cloud uses bearer auth and prompt schema without unsupported format', async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.LLM_PROVIDER = 'ollama';
  process.env.OLLAMA_BASE_URL = 'https://ollama.com';
  process.env.OLLAMA_API_KEY = 'synthetic-test-key';
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ message: { content: '```json\n{"summary":"Hello"}\n```' } }) };
  });
  assert.deepEqual(JSON.parse(await completeJson('Summarize.', 'User: hello', { type: 'object' })), { summary: 'Hello' });
  assert.equal(request.url, 'https://ollama.com/api/chat');
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-test-key');
  assert.equal(request.body.format, undefined);
  assert.match(request.body.messages[0].content, /JSON schema/);
  assert.equal(request.options.redirect, 'error');
});

test('cloud requires a key before making any request', async (t) => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; });
  process.env.LLM_PROVIDER = 'ollama'; process.env.OLLAMA_BASE_URL = 'https://ollama.com';
  delete process.env.OLLAMA_API_KEY;
  await assert.rejects(completeJson('Summarize.', 'Hello'), /Missing OLLAMA_API_KEY/);
});

test('invalid model JSON cannot be passed into the call pipeline', async (t) => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; });
  process.env.LLM_PROVIDER = 'ollama'; process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ message: { content: 'not JSON' } }) }));
  await assert.rejects(completeJson('Summarize.', 'Hello'), /invalid JSON/);
});


test('production sends no transcript to an undisclosed model', async (t) => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; });
  Object.assign(process.env, { VERCEL_ENV: 'production', LLM_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'https://ollama.com', OLLAMA_API_KEY: 'k' });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  await assert.rejects(completeJson('Summarize.', 'User: hello'), /LLM_PROVIDER=openai/);
  assert.equal(fetchMock.mock.callCount(), 0);
});


test('OpenAI requests refuse redirects', async (t) => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; });
  Object.assign(process.env, { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
  delete process.env.OPENAI_BASE_URL;
  let init;
  t.mock.method(globalThis, 'fetch', async (_url, i) => {
    init = i;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  await completeJson('Summarize.', 'User: hello');
  assert.equal(init.redirect, 'error');
});
