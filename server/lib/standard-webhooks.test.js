import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from './standard-webhooks.js';

const key = Buffer.from('a-test-signing-key-of-some-length');
const secret = `whsec_${key.toString('base64')}`;
const now = 1_780_000_000_000;
const sign = (k, id, ts, body) => `v1,${createHmac('sha256', k).update(`${id}.${ts}.${body}`).digest('base64')}`;

test('accepts Standard Webhooks signatures and Polar legacy raw secrets', () => {
  const body = '{"type":"order.paid"}', ts = String(now / 1000);
  verifyWebhook({ body: Buffer.from(body), id: 'msg_1', timestamp: ts, signature: `v1,bm9wZQ== ${sign(key, 'msg_1', ts, body)}` }, secret, now);
  verifyWebhook({ body: Buffer.from(body), id: 'msg_1', timestamp: ts, signature: sign(Buffer.from('legacy'), 'msg_1', ts, body) }, 'legacy', now);
});

test('rejects tampering, replays outside five minutes, and missing parts', () => {
  const body = '{"type":"order.paid"}', ts = String(now / 1000);
  const good = { body: Buffer.from(body), id: 'msg_1', timestamp: ts, signature: sign(key, 'msg_1', ts, body) };
  assert.throws(() => verifyWebhook({ ...good, body: Buffer.from('{"type":"order.refunded"}') }, secret, now));
  assert.throws(() => verifyWebhook({ ...good, id: 'msg_2' }, secret, now));
  assert.throws(() => verifyWebhook(good, secret, now + 301_000));
  assert.throws(() => verifyWebhook(good, `whsec_${Buffer.from('other').toString('base64')}`, now));
  assert.throws(() => verifyWebhook({ ...good, signature: undefined }, secret, now));
  assert.throws(() => verifyWebhook({ ...good, body: undefined }, secret, now));
  assert.throws(() => verifyWebhook(good, undefined, now));
});
