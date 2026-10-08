import { createHmac, timingSafeEqual } from 'node:crypto';

const keyOf = secret => secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');

/** Sign an outgoing request the way verifyWebhook checks it (used for MiniMe). */
export function signWebhook(secret, id, timestamp, body) {
  return `v1,${createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.`).update(body).digest('base64')}`;
}

/**
 * Verify a Standard Webhooks signature (https://www.standardwebhooks.com/), as
 * Polar sends them. Polar secrets made since 8 September 2026 are `whsec_` +
 * base64 key; older ones are used as raw text. Both are accepted, like Polar's
 * SDKs do. Throws on any mismatch; never says which part failed.
 */
export function verifyWebhook({ body, id, timestamp, signature }, secret, now = Date.now()) {
  if (!secret || !Buffer.isBuffer(body) || !id || !timestamp || !signature) throw new Error('Invalid webhook signature');
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > 300) throw new Error('Invalid webhook signature');
  const keys = secret.startsWith('whsec_') ? [Buffer.from(secret.slice(6), 'base64')] : [Buffer.from(secret, 'utf8')];
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), body]);
  const offered = signature.split(' ').filter(part => part.startsWith('v1,')).map(part => Buffer.from(part.slice(3), 'base64'));
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(signed).digest();
    if (offered.some(candidate => candidate.length === expected.length && timingSafeEqual(candidate, expected))) return;
  }
  throw new Error('Invalid webhook signature');
}
