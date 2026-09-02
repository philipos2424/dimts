import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';

process.env.PUBLIC_BASE_URL = 'https://dimts.ngrok-free.app';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
delete process.env.SKIP_TWILIO_SIGNATURE_CHECK; // signature checking ON

mock.module('../db/pool.js', {
  namedExports: {
    query: async () => ({ rows: [] }),
    queryOne: async () => undefined,
    getPool: () => ({}),
  },
});
mock.module('../services/process-recording.js', {
  namedExports: { processRecording: async () => {} },
});

const { createApp } = await import('../app.js');
const app = createApp();

async function post(path, body, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body).toString(),
    });
  } finally {
    server.close();
  }
}

const PATH = '/twiml/dial-done?callId=abc';
const BODY = { DialCallStatus: 'completed', DialCallDuration: '60' };

test('rejects an unsigned webhook', async () => {
  const res = await post(PATH, BODY);
  assert.equal(res.status, 403);
});

test('rejects a webhook signed with the wrong auth token', async () => {
  const signature = twilio.getExpectedTwilioSignature(
    'attacker-token',
    process.env.PUBLIC_BASE_URL + PATH,
    BODY
  );
  const res = await post(PATH, BODY, { 'X-Twilio-Signature': signature });
  assert.equal(res.status, 403);
});

test('accepts a correctly signed webhook', async () => {
  const signature = twilio.getExpectedTwilioSignature(
    'test-auth-token',
    process.env.PUBLIC_BASE_URL + PATH,
    BODY
  );
  const res = await post(PATH, BODY, { 'X-Twilio-Signature': signature });
  assert.equal(res.status, 200);
});
