import express from 'express';
import { randomBytes } from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import { isE164 } from '../lib/phone.js';
import { canCall, signupCountryCode } from '../lib/destinations.js';
import { hashToken, HttpError, resolveUser } from '../lib/users.js';
import { checkPhoneCode, sendPhoneCode } from '../services/verify-phone.js';
import { audit } from '../lib/audit.js';
import { hit } from '../lib/rate-limit.js';
import { hasAcceptedTerms } from '../lib/terms.js';

export const authRouter = express.Router();

// Durable counters also work across concurrent Vercel function instances.
const limit = (key, maximum) => hit(key, maximum, 3600);

/** Numbers outside the signup countries that may still receive a code. */
async function signInException(phone) {
  if (!canCall(phone)) return false;
  const invited = (process.env.SIGNUP_ALLOWED_NUMBERS ?? '').split(',').map(n => n.trim()).filter(Boolean);
  if (invited.includes(phone)) return true;
  return !!(await queryOne('SELECT 1 AS found FROM users WHERE phone=$1 AND deleted_at IS NULL', [phone]));
}

authRouter.post('/start', async (req, res) => {
  const { phone } = req.body ?? {};
  if (!isE164(phone)) throw new HttpError(400, 'invalid_phone');
  if (phone === process.env.TWILIO_NUMBER) throw new HttpError(400, 'handset_required', 'Use your mobile number, not the Twilio number.');
  // SMS pumping sends codes to expensive ranges; refuse them before paying for one.
  // Existing accounts and invited numbers may still sign in from anywhere we can call.
  const country = signupCountryCode(phone) ?? (await signInException(phone) ? 'exception' : null);
  if (!country) throw new HttpError(403, 'country_not_supported', 'Dimts is not available for phone numbers in this country yet.');
  await limit(`send-phone:${phone}`, 5);
  await limit(`send-ip:${req.ip}`, 20);
  // Ceilings that rotating numbers and addresses cannot escape.
  await limit(`send-country:${country}`, 300);
  await limit('send-all', 1000);
  await sendPhoneCode(phone);
  res.status(202).json({ status: 'code_sent' });
});

authRouter.post('/verify', async (req, res) => {
  const { phone, code } = req.body ?? {};
  if (!isE164(phone) || typeof code !== 'string' || !/^\d{4,10}$/.test(code)) {
    throw new HttpError(400, 'invalid_verification');
  }
  await limit(`check-phone:${phone}`, 15);
  await limit(`check-ip:${req.ip}`, 40);
  if (!(await checkPhoneCode(phone, code))) throw new HttpError(401, 'invalid_code');
  const user = await queryOne(
    `INSERT INTO users (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING id, phone, tier, terms_version`, [phone]
  );
  const token = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`, [hashToken(token), user.id]
  );
  await audit({ userId: user.id, action: 'signed_in', req });
  res.set('Cache-Control', 'no-store').json({ token, phone: user.phone, terms_required: !hasAcceptedTerms(user) });
});

authRouter.post('/logout', async (req, res) => {
  const user = await resolveUser(req);
  const token = req.get('authorization').slice(7);
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  await audit({ userId: user.id, action: 'signed_out', req });
  res.json({ status: 'signed_out' });
});
