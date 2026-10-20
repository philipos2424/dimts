import test from 'node:test';
import assert from 'node:assert/strict';
import { sealAppleToken, openAppleToken } from './social-secrets.js';

test('Apple credentials require encryption and cannot be moved between subjects', () => {
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  assert.throws(() => sealAppleToken('private-refresh', 'owner'));
  process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
  const sealed = sealAppleToken('private-refresh', 'owner');
  assert.ok(!sealed.includes('private-refresh'));
  assert.equal(openAppleToken(sealed, 'owner'), 'private-refresh');
  assert.throws(() => openAppleToken(sealed, 'other'));
  process.env.INTEGRATION_ENCRYPTION_KEY = 'cd'.repeat(32);
  assert.throws(() => openAppleToken(sealed, 'owner'));
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
});
