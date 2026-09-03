import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_NAME_CONFIDENCE, shouldAdoptName } from './contact-policy.js';

const candidate = { name: 'Phili', company: 'Amax', confidence: 0.9 };

test('adopts a confident name for a contact we have never named', () => {
  assert.equal(shouldAdoptName(null, candidate), true);
});

test('adopts over a previously extracted name', () => {
  const existing = { display_name: 'Phil', name_source: 'extracted', name_confidence: 0.6 };
  assert.equal(shouldAdoptName(existing, candidate), true);
});

test('never overwrites a name the user set themselves', () => {
  const existing = { display_name: 'Phili - Amax procurement', name_source: 'user', name_confidence: null };
  assert.equal(shouldAdoptName(existing, candidate), false);
});

test('does not replace a stronger extraction with a weaker one', () => {
  const existing = { display_name: 'Philippa', name_source: 'extracted', name_confidence: 0.95 };
  assert.equal(shouldAdoptName(existing, candidate), false);
});

test('rejects a candidate below the confidence floor', () => {
  assert.equal(shouldAdoptName(null, { ...candidate, confidence: MIN_NAME_CONFIDENCE - 0.01 }), false);
});

test('rejects a candidate with no name', () => {
  assert.equal(shouldAdoptName(null, { name: '', company: 'Amax', confidence: 0.99 }), false);
  assert.equal(shouldAdoptName(null, { name: null, company: null, confidence: 0.99 }), false);
});

test('rejects a missing candidate', () => {
  assert.equal(shouldAdoptName(null, null), false);
});
