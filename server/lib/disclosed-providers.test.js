import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDisclosed } from './disclosed-providers.js';

const prod = { VERCEL_ENV: 'production' };

test('production refuses to send call content to an undisclosed provider', () => {
  assert.throws(() => assertDisclosed('llm', 'ollama', prod), /LLM_PROVIDER=openai/);
  assert.throws(() => assertDisclosed('transcription', 'whisper', prod), /TRANSCRIBE_PROVIDER=elevenlabs/);
  assert.doesNotThrow(() => assertDisclosed('llm', 'openai', prod));
  assert.doesNotThrow(() => assertDisclosed('transcription', 'elevenlabs', prod));
});

test('a base-URL override may only choose the same provider\'s endpoints', () => {
  assert.doesNotThrow(() => assertDisclosed('llm', 'openai', { ...prod, OPENAI_BASE_URL: 'https://eu.api.openai.com/v1' }));
  assert.doesNotThrow(() => assertDisclosed('transcription', 'elevenlabs', { ...prod, ELEVENLABS_BASE_URL: 'https://api.eu.residency.elevenlabs.io' }));
  assert.throws(() => assertDisclosed('llm', 'openai', { ...prod, OPENAI_BASE_URL: 'https://proxy.example.com/v1' }), /OPENAI_BASE_URL/);
  assert.throws(() => assertDisclosed('transcription', 'elevenlabs', { ...prod, ELEVENLABS_BASE_URL: 'http://api.elevenlabs.io' }), /ELEVENLABS_BASE_URL/);
  assert.throws(() => assertDisclosed('llm', 'openai', { ...prod, OPENAI_BASE_URL: 'not a url' }), /OPENAI_BASE_URL/);
});

test('production outside Vercel is protected too; previews and development are not restricted', () => {
  assert.throws(() => assertDisclosed('llm', 'ollama', { NODE_ENV: 'production' }), /LLM_PROVIDER/);
  assert.doesNotThrow(() => assertDisclosed('llm', 'ollama', { VERCEL_ENV: 'preview', NODE_ENV: 'production' }));
  assert.doesNotThrow(() => assertDisclosed('transcription', 'whisper', {}));
});
