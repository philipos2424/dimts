import test from 'node:test';
import assert from 'node:assert/strict';
import { openingOf, parseIdentity } from './identify.js';

test('parses a confident identification', () => {
  const result = parseIdentity(
    JSON.stringify({ name: 'Phili', company: 'Amax', confidence: 0.92 })
  );
  assert.deepEqual(result, { name: 'Phili', company: 'Amax', confidence: 0.92 });
});

test('returns a null identity when the caller never introduces themselves', () => {
  const result = parseIdentity(
    JSON.stringify({ name: null, company: null, confidence: 0 })
  );
  assert.equal(result.name, null);
  assert.equal(result.confidence, 0);
});

test('treats an empty name as no identification', () => {
  const result = parseIdentity(JSON.stringify({ name: '   ', confidence: 0.9 }));
  assert.equal(result.name, null);
});

test('clamps confidence into 0..1', () => {
  assert.equal(parseIdentity(JSON.stringify({ name: 'A', confidence: 5 })).confidence, 1);
  assert.equal(parseIdentity(JSON.stringify({ name: 'A', confidence: -2 })).confidence, 0);
});

test('defaults a missing confidence to zero rather than guessing', () => {
  assert.equal(parseIdentity(JSON.stringify({ name: 'Phili' })).confidence, 0);
});

test('returns a null identity for unparseable output instead of throwing', () => {
  // Identification is best-effort: a bad response must not fail the call.
  assert.deepEqual(parseIdentity('sorry, I cannot help'), {
    name: null,
    company: null,
    confidence: 0,
  });
});

test('openingOf takes only the first lines of a transcript', () => {
  const transcript = ['Caller: hi', 'User: hello', 'Caller: so about the order', 'User: yes'].join('\n');
  assert.equal(openingOf(transcript, 2), 'Caller: hi\nUser: hello');
});

test('openingOf handles a transcript shorter than the window', () => {
  assert.equal(openingOf('Caller: hi', 5), 'Caller: hi');
});
