import { queryOne } from '../db/pool.js';
import { isE164 } from '../services/originate.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Identify the caller from the `x-user-phone` header.
 *
 * This is deliberately not authentication — the header is trivially spoofable
 * and anyone can read another user's calls by guessing a phone number. It is
 * the agreed shortcut to a working build; replacing it with verified OTP +
 * JWT is tracked as deferred work.
 */
export async function resolveUser(req) {
  const phone = req.get('x-user-phone');

  if (!isE164(phone)) {
    throw new HttpError(
      401,
      'invalid_user_phone',
      'x-user-phone header must be an E.164 number'
    );
  }

  return queryOne(
    `INSERT INTO users (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING id, phone, tier`,
    [phone]
  );
}

/** 'YYYY-MM' in UTC, matching usage_minutes.month. */
export function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}
