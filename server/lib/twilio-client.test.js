import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'auth-token';
const made = [];
mock.module('twilio', { defaultExport: (user, password, options) => { made.push({ user, password, options }); return {}; } });
const { twilioBasicAuth, twilioClient } = await import('./twilio-client.js');
const decode = header => Buffer.from(header.slice(6), 'base64').toString();
const KEY = 'SK' + 'b'.repeat(32);

test.beforeEach(() => { made.length = 0; delete process.env.TWILIO_API_KEY_SID; delete process.env.TWILIO_API_KEY_SECRET; });

test('uses the API key, scoped to the account, when one is configured', () => {
  process.env.TWILIO_API_KEY_SID = KEY; process.env.TWILIO_API_KEY_SECRET = 'key-secret';
  twilioClient({ timeout: 5000 });
  assert.deepEqual(made[0], { user: KEY, password: 'key-secret', options: { timeout: 5000, accountSid: process.env.TWILIO_ACCOUNT_SID } });
  assert.equal(decode(twilioBasicAuth()), `${KEY}:key-secret`);
});

test('falls back to the auth token when no API key is configured', () => {
  twilioClient({}, 'AC' + 'c'.repeat(32));
  assert.deepEqual(made[0], { user: 'AC' + 'c'.repeat(32), password: 'auth-token', options: {} });
  assert.equal(decode(twilioBasicAuth()), `${process.env.TWILIO_ACCOUNT_SID}:auth-token`);
});

test('refuses half-configured or malformed API keys instead of silently using the auth token', () => {
  process.env.TWILIO_API_KEY_SID = KEY;
  assert.throws(() => twilioClient(), /must be set together/);
  process.env.TWILIO_API_KEY_SID = 'not-a-key'; process.env.TWILIO_API_KEY_SECRET = 'key-secret';
  assert.throws(() => twilioBasicAuth(), /must be set together/);
});
