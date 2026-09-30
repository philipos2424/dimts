import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecording } from './originate.js';

process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'test-secret';

test('never sends Twilio credentials to an untrusted URL', async () => {
  for (const url of [
    'http://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE1',
    'https://evil.example/2010-04-01/Accounts/ACtest/Recordings/RE1',
    'https://api.twilio.com/2010-04-01/Accounts/ACother/Recordings/RE1',
    'https://api.twilio.com@evil.example/Recordings/RE1',
  ]) await assert.rejects(fetchRecording(url), /Untrusted recording URL/);
});

test('requests dual-channel audio with a timeout and rejects credential redirects', async (t) => {
  let requested;
  t.mock.method(globalThis, 'fetch', async (url, options) => { requested = { url, options }; return { ok: true }; });
  await fetchRecording('https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE1');
  assert.equal(String(requested.url), 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE1.mp3?RequestedChannels=2');
  assert.equal(requested.options.redirect, 'error');
  assert.ok(requested.options.signal instanceof AbortSignal);
  assert.match(requested.options.headers.Authorization, /^Basic /);
});
