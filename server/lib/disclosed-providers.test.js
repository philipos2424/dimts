import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDisclosed } from './disclosed-providers.js';

test('production refuses to send call content to an undisclosed provider', () => {
  const prod = { VERCEL_ENV: 'production' };
  assert.throws(() => assertDisclosed('llm', 'ollama', prod), /LLM_PROVIDER=openai/);
  assert.throws(() => assertDisclosed('transcription', 'whisper', prod), /TRANSCRIBE_PROVIDER=elevenlabs/);
  assert.doesNotThrow(() => assertDisclosed('llm', 'openai', prod));
  assert.doesNotThrow(() => assertDisclosed('transcription', 'elevenlabs', prod));
});

test('development and previews may use local providers', () => {
  assert.doesNotThrow(() => assertDisclosed('llm', 'ollama', { VERCEL_ENV: 'preview' }));
  assert.doesNotThrow(() => assertDisclosed('transcription', 'whisper', {}));
});
