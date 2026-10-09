import test from 'node:test';
import assert from 'node:assert/strict';
import { beforeSend, isEuDsn } from './sentry-privacy.cjs';
import * as Sentry from '@sentry/node';

const callId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const secret = 'PRIVATE_CALL_CONTENT +251911234567 https://audio.example/private.mp3?token=SECRET';
const dirty = () => ({
  event_id: 'a'.repeat(32), timestamp: 123,
  request: { data: { transcript: secret, summary: secret }, headers: { authorization: secret }, url: secret },
  phone: secret, transcript: secret, summary: secret, audio_url: secret,
  user: { id: userId, email: secret, ip_address: secret, username: secret, phone: secret },
  tags: { stage: 'transcription', carrier: 'telnyx', call_id: callId, phone: secret, transcript: secret },
  extra: { nested: { content: secret } }, contexts: { call: { summary: secret } },
  breadcrumbs: [{ message: secret, data: { url: secret } }],
  message: secret, logentry: { formatted: secret }, transaction: secret, fingerprint: [secret],
  exception: { values: [{ type: 'TypeError', value: secret, mechanism: { data: { content: secret } },
    stacktrace: { frames: [{ filename: secret, vars: { transcript: secret }, context_line: secret }] } }] },
});

test('beforeSend strips all call content, bodies, phones, audio URLs and arbitrary nested fields', () => {
  const input = dirty();
  const clean = beforeSend(input);
  assert.deepEqual(clean, {
    event_id: 'a'.repeat(32), timestamp: 123, level: 'error',
    tags: { stage: 'transcription', carrier: 'telnyx', call_id: callId }, user: { id: userId },
    exception: { values: [{ type: 'TypeError', value: '[redacted]' }] },
  });
  assert.equal(input.request.data.transcript, secret, 'do not mutate input');
  assert.deepEqual(beforeSend(clean), clean, 'filter is idempotent');
});

test('provider response tails and malicious metadata never survive the allowlist', () => {
  const input = dirty();
  input.exception.values[0].value = `ElevenLabs request failed (HTTP 429): ${secret}`;
  assert.equal(beforeSend(input).exception.values[0].value, 'ElevenLabs request failed (HTTP 429)');
  input.tags = { stage: secret, carrier: secret, call_id: '+251911234567' };
  input.user.id = secret;
  input.exception.values[0].type = secret;
  input.exception.values[0].value = `Transcription returned no speech ${secret}`;
  assert.deepEqual(beforeSend(input).tags, {});
  assert.equal(beforeSend(input).user, undefined);
  assert.deepEqual(beforeSend(input).exception.values, [{ type: 'Error', value: '[redacted]' }]);
  assert.deepEqual(beforeSend({ message: secret }), { level: 'error', tags: {}, message: '[redacted]' });
});

test('EU DSNs are validated without allowing US hosts, credentials, queries or lookalike domains', () => {
  assert.equal(isEuDsn('https://abcdef@o123.ingest.de.sentry.io/456'), true);
  for (const dsn of ['', 'invalid', 'https://abcdef@o123.ingest.us.sentry.io/456',
    'https://abcdef@o123.ingest.de.sentry.io.evil.test/456',
    'http://abcdef@o123.ingest.de.sentry.io/456', 'https://abcdef:secret@o123.ingest.de.sentry.io/456',
    'https://abcdef@o123.ingest.de.sentry.io/456?url=private']) assert.equal(isEuDsn(dsn), false);
});

test('the real SDK transport receives only the sanitized error envelope, with no network', async () => {
  const envelopes = [];
  Sentry.init({ dsn: 'https://abcdef@o123.ingest.de.sentry.io/456', defaultIntegrations: false,
    sendDefaultPii: false, sendClientReports: false, beforeSend,
    transport: () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }),
  });
  try {
    Sentry.captureEvent(dirty());
    await Sentry.flush(1000);
    assert.equal(envelopes.length, 1);
    const serialized = JSON.stringify(envelopes);
    assert.doesNotMatch(serialized, /PRIVATE_CALL_CONTENT|251911234567|audio\.example|SECRET/);
    assert.match(serialized, /transcription/);
    assert.match(serialized, new RegExp(callId));
  } finally { await Sentry.close(1000); }
});
