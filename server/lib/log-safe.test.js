import test from 'node:test';
import assert from 'node:assert/strict';
import { maskPhones, safeError } from './log-safe.js';

test('phone numbers are masked in logged errors, ids and short numbers are kept', () => {
  assert.equal(maskPhones('call to +251911234567 failed'), 'call to …67 failed');
  const err = Object.assign(new Error('duplicate key'), { detail: 'Key (phone)=(+14155552671) already exists.' });
  const line = safeError(err);
  assert.doesNotMatch(line, /4155552671/);
  assert.match(line, /duplicate key/);
  assert.equal(maskPhones('HTTP 400 after 30000 ms'), 'HTTP 400 after 30000 ms');
});
