import { randomBytes } from 'node:crypto';
import { isE164 } from './phone.js';

/** No setup link may be valid for longer than this, however its expiry is written. */
export const SETUP_MAX_HOURS = 24 * 7;

/**
 * ADMIN_SETUP_TOKEN is "<staff phone>:<64 hex secret>:<expiry as Unix seconds>".
 * The expiry is required and may be at most SETUP_MAX_HOURS away, so a link
 * left in the environment cannot stay open indefinitely. Returns null for
 * anything that is not exactly that; an expired value still parses, and the
 * caller says it expired.
 */
export function parseSetupToken(value, now = Date.now()) {
  const [phone, secret, expiry, extra] = String(value ?? '').trim().split(':');
  if (extra !== undefined || !isE164(phone ?? '') || !/^[a-f0-9]{64}$/.test(secret ?? '') || !/^\d{9,11}$/.test(expiry ?? '')) return null;
  const expiresAt = new Date(Number(expiry) * 1000);
  if (expiresAt.getTime() - now > SETUP_MAX_HOURS * 3_600_000) return null;
  return { phone, secret, expiresAt };
}

/** A fresh secret and the environment value that carries it. Used by scripts/admin-setup-link.js. */
export function newSetupToken(phone, { hours = 24, now = Date.now() } = {}) {
  if (!isE164(phone)) throw new Error('The phone must be a full international number, like +14155550100.');
  if (!(hours > 0 && hours <= SETUP_MAX_HOURS)) throw new Error(`The link must last between 0 and ${SETUP_MAX_HOURS} hours.`);
  const secret = randomBytes(32).toString('hex');
  const expiresAt = new Date(now + hours * 3_600_000);
  return { secret, expiresAt, env: `${phone}:${secret}:${Math.floor(expiresAt.getTime() / 1000)}` };
}
