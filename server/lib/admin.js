import { queryOne } from '../db/pool.js';
import { isE164 } from './phone.js';
import { HttpError, hashToken, resolveUser } from './users.js';
import { isReviewDemo } from './review-demo.js';
import { signupCountryCode } from './destinations.js';
import { EEA_CODES } from './pricing.js';

/**
 * Who may open the operator console. An allowlist of owners' phone numbers in
 * ADMIN_PHONES, signed in through the normal phone code. Anyone else gets the
 * same 404 as a missing route, so the console's existence is not advertised.
 */
export function adminPhones(env = process.env) {
  return new Set((env.ADMIN_PHONES ?? '').split(',').map(phone => phone.trim()).filter(isE164));
}

// Staff access needs a recent sign-in, not a 30-day app session left open on a laptop.
export const ADMIN_SESSION_HOURS = 12;

export async function requireAdmin(req) {
  let user;
  try { user = await resolveUser(req); } catch { throw new HttpError(404, 'not_found'); }
  if (isReviewDemo(user.phone) || !adminPhones().has(user.phone)) throw new HttpError(404, 'not_found');
  const token = req.get('authorization').match(/^Bearer ([a-f0-9]{64})$/i)[1];
  const fresh = await queryOne(`SELECT 1 AS ok FROM sessions WHERE token_hash=$1
    AND created_at > now() - make_interval(hours => $2)`, [hashToken(token), ADMIN_SESSION_HOURS]);
  if (!fresh) throw new HttpError(403, 'reauth_required', `Sign in again: staff access needs a sign-in from the last ${ADMIN_SESSION_HOURS} hours.`);
  return user;
}

/** Why staff looked at one person's details. A fixed list, so the log never holds free text about anyone. */
export const ACCESS_REASONS = ['support_request', 'billing_issue', 'fraud_or_abuse', 'legal_request', 'security_incident'];

/** "+1 ••• ••• 1234": enough to match a customer on the phone, not enough to dial them. */
export function maskPhone(phone) {
  if (!isE164(phone)) return phone?.startsWith('deleted:') ? 'deleted' : '—';
  const code = signupCountryCode(phone);
  const prefix = code ? `+${code}` : phone.slice(0, 3);
  return `${prefix} ••• ${phone.slice(-4)}`;
}

const GULF = new Set(['971', '966', '974', '973', '965', '968']);

/** Market an account belongs to, from the calling code of its verified number. */
export function regionOf(phone) {
  const code = isE164(phone) ? signupCountryCode(phone) : null;
  if (!code) return 'Other';
  if (code === '1') return 'US/Canada';
  if (code === '44') return 'UK';
  if (EEA_CODES.has(code)) return 'EU/EEA';
  if (GULF.has(code)) return 'Gulf';
  if (code === '251') return 'Ethiopia';
  return 'Other';
}
