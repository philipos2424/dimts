import test from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';

process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.PUBLIC_BASE_URL = 'https://dimts.ngrok-free.app';

const { isValidTwilioRequest, signedUrlFor } = await import('./twilio-signature.js');

const AUTH_TOKEN = 'test-auth-token';
const PUBLIC_URL = 'https://dimts.ngrok-free.app/webhooks/recording-ready?callId=abc';
const BODY = { CallSid: 'CA123', RecordingStatus: 'completed' };

function fakeReq(signature, { originalUrl = '/webhooks/recording-ready?callId=abc' } = {}) {
  return {
    originalUrl,
    body: BODY,
    get: (name) => (name === 'X-Twilio-Signature' ? signature : undefined),
  };
}

test('rebuilds the public URL Twilio signed, not the internal one', () => {
  assert.equal(signedUrlFor(fakeReq('x')), PUBLIC_URL);
});

test('strips a trailing slash from PUBLIC_BASE_URL so the URL is not doubled', async () => {
  const original = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://dimts.ngrok-free.app/';
  assert.equal(signedUrlFor(fakeReq('x')), PUBLIC_URL);
  process.env.PUBLIC_BASE_URL = original;
});

test('accepts a signature computed over the external URL', () => {
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, PUBLIC_URL, BODY);
  assert.equal(isValidTwilioRequest(fakeReq(signature)), true);
});

test('rejects a signature computed over the internal URL (the ngrok/Vercel trap)', () => {
  const internal = twilio.getExpectedTwilioSignature(
    AUTH_TOKEN,
    'http://localhost:3000/webhooks/recording-ready?callId=abc',
    BODY
  );
  assert.equal(isValidTwilioRequest(fakeReq(internal)), false);
});

test('rejects a request with no signature header', () => {
  assert.equal(isValidTwilioRequest(fakeReq(undefined)), false);
});

test('rejects a signature valid for a different callId', () => {
  const other = twilio.getExpectedTwilioSignature(
    AUTH_TOKEN,
    'https://dimts.ngrok-free.app/webhooks/recording-ready?callId=zzz',
    BODY
  );
  assert.equal(isValidTwilioRequest(fakeReq(other)), false);
});

test('rejects a tampered body', () => {
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, PUBLIC_URL, BODY);
  const req = fakeReq(signature);
  req.body = { ...BODY, RecordingStatus: 'absent' };
  assert.equal(isValidTwilioRequest(req), false);
});
