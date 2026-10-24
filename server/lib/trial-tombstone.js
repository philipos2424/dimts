import { createHmac } from 'node:crypto';
import { isE164 } from './phone.js';

/** Reuse the audit secret, but never audit.js's public development fallback. */
export function trialPhoneHash(phone) {
  const secret = process.env.AUDIT_SALT;
  if (!secret || secret.length < 32) throw new Error('AUDIT_SALT must have at least 32 characters');
  if (!isE164(phone)) throw new Error('Trial phone must be E.164');
  return createHmac('sha256', secret).update(`trial-phone:${phone}`).digest('hex');
}
