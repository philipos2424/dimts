import test from 'node:test';
import assert from 'node:assert/strict';
import { isE164, normalizePhone } from './phone.js';

test('accepts a well-formed E.164 number', () => {
  assert.equal(isE164('+14155552671'), true);
});

test('rejects numbers without a country code', () => {
  assert.equal(isE164('4155552671'), false);
});

test('rejects a leading zero after the plus', () => {
  assert.equal(isE164('+04155552671'), false);
});

test('rejects non-strings', () => {
  assert.equal(isE164(undefined), false);
  assert.equal(isE164(null), false);
  assert.equal(isE164(14155552671), false);
});

test('strips spaces, dashes and parentheses', () => {
  assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671');
});

test('returns null for anything that is not dialable', () => {
  assert.equal(normalizePhone('unknown'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('preserves an already-normalised number', () => {
  assert.equal(normalizePhone('+251911234567'), '+251911234567');
});
