/**
 * Staff sign in to the operator console with a passkey: Face ID, a
 * fingerprint or the device PIN, with no text code. A passkey is added once
 * from a normal (phone-code) sign-in, then works on its own. The private key
 * never leaves the staff member's device; we keep only its public key.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import * as database from '../db/pool.js';
import { config } from '../config.js';
import { HttpError, hashToken } from '../lib/users.js';
import { isE164 } from '../lib/phone.js';
import { audit } from '../lib/audit.js';
import { ADMIN_SESSION_HOURS, adminPhones, maskPhone } from '../lib/admin.js';

const b64url = bytes => Buffer.from(bytes).toString('base64url');
const fromB64url = text => new Uint8Array(Buffer.from(text, 'base64url'));

/** The site a passkey is bound to: the public host, so a look-alike domain can never use it. */
export function relyingParty() {
  const origin = new URL(process.env.ADMIN_PASSKEY_ORIGIN || config.publicBaseUrl).origin;
  return { origin, rpID: new URL(origin).hostname };
}

async function saveChallenge(challenge, kind, userId = null) {
  await database.query(`DELETE FROM admin_challenges WHERE expires_at < now()`);
  await database.query(`INSERT INTO admin_challenges(challenge, kind, user_id) VALUES($1, $2, $3)`, [challenge, kind, userId]);
}

/** Single use: a challenge is deleted as it is read, so a captured response cannot be replayed. */
async function takeChallenge(challenge, kind, userId = null) {
  const row = await database.queryOne(`DELETE FROM admin_challenges WHERE challenge = $1 AND kind = $2
    AND expires_at > now() AND user_id IS NOT DISTINCT FROM $3 RETURNING challenge`, [challenge, kind, userId]);
  if (!row) throw new HttpError(400, 'challenge_expired', 'That took too long. Try again.');
  return row.challenge;
}

const challengeOf = response => {
  try {
    return JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge;
  } catch { throw new HttpError(400, 'invalid_passkey_response'); }
};

export async function registrationOptions(staff) {
  const { rpID } = relyingParty();
  const { rows } = await database.query('SELECT id, transports FROM admin_passkeys WHERE user_id = $1', [staff.id]);
  const options = await generateRegistrationOptions({
    rpName: 'Dimts Console',
    rpID,
    userName: `Dimts staff ${maskPhone(staff.phone)}`,
    userID: new TextEncoder().encode(staff.id),
    attestationType: 'none',
    excludeCredentials: rows.map(row => ({ id: row.id, transports: row.transports ?? undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await saveChallenge(options.challenge, 'register', staff.id);
  return options;
}

export async function finishRegistration(staff, response) {
  const expectedChallenge = await takeChallenge(challengeOf(response), 'register', staff.id);
  const { origin, rpID } = relyingParty();
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
  }).catch(() => ({ verified: false }));
  if (!verified) throw new HttpError(400, 'passkey_not_verified', 'The passkey could not be verified.');
  const { credential } = registrationInfo;
  await database.query(`INSERT INTO admin_passkeys(id, user_id, public_key, counter, transports) VALUES($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO NOTHING`, [credential.id, staff.id, b64url(credential.publicKey), credential.counter, credential.transports ?? null]);
  return { id: credential.id };
}

export async function authenticationOptions() {
  const { rpID } = relyingParty();
  // No list of credentials: the device offers the passkey it holds for this site.
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  await saveChallenge(options.challenge, 'login');
  return options;
}

/** Verify the passkey and open a staff session of ADMIN_SESSION_HOURS. Returns the session token. */
export async function finishAuthentication(response) {
  const expectedChallenge = await takeChallenge(challengeOf(response), 'login');
  const key = await database.queryOne(`SELECT k.id, k.user_id, k.public_key, k.counter, k.transports, u.phone
    FROM admin_passkeys k JOIN users u ON u.id = k.user_id WHERE k.id = $1 AND u.deleted_at IS NULL`, [String(response?.id ?? '')]);
  // Staff who were removed from ADMIN_PHONES keep their passkey row but can no longer use it.
  if (!key || !adminPhones().has(key.phone)) throw new HttpError(401, 'passkey_not_recognised', 'This passkey is not set up for the console.');
  const { origin, rpID } = relyingParty();
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: { id: key.id, publicKey: fromB64url(key.public_key), counter: Number(key.counter), transports: key.transports ?? undefined },
  }).catch(() => ({ verified: false }));
  if (!verified) throw new HttpError(401, 'passkey_not_verified', 'The passkey could not be verified.');
  await database.query('UPDATE admin_passkeys SET counter = $2, last_used_at = now() WHERE id = $1', [key.id, authenticationInfo.newCounter]);
  return { token: await openStaffSession(key.user_id), userId: key.user_id };
}

/** A console session of ADMIN_SESSION_HOURS, separate from the 30-day app session. */
async function openStaffSession(userId) {
  const token = randomBytes(32).toString('hex');
  await database.query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), userId, ADMIN_SESSION_HOURS]);
  return token;
}

export async function listPasskeys(staff) {
  const { rows } = await database.query(`SELECT id, created_at, last_used_at FROM admin_passkeys WHERE user_id = $1 ORDER BY created_at`, [staff.id]);
  return rows.map(row => ({ ...row, id: row.id.slice(0, 8) }));
}

export async function removePasskey(staff, idPrefix) {
  const prefix = String(idPrefix ?? '');
  if (!/^[A-Za-z0-9_-]{8}$/.test(prefix)) throw new HttpError(400, 'invalid_passkey');
  const { rows } = await database.query(`DELETE FROM admin_passkeys WHERE user_id = $1 AND left(id, 8) = $2 RETURNING id`, [staff.id, prefix]);
  return { removed: rows.length };
}

/**
 * First passkey without a text or call: a one-time setup link. The operator
 * sets ADMIN_SETUP_TOKEN="<staff phone>:<64 hex>" in Vercel; the link is
 * /admin/#setup=<64 hex>. It works once (its use is recorded in the audit
 * log and checked before every use), only for a number on ADMIN_PHONES, and
 * a new value in the variable issues a new link (for a lost device).
 */
const digest = value => createHash('sha256').update(String(value)).digest();

function setupGrant(token) {
  const [phone, secret] = String(process.env.ADMIN_SETUP_TOKEN ?? '').trim().split(':');
  if (!isE164(phone) || !/^[a-f0-9]{64}$/.test(secret ?? '') || !adminPhones().has(phone)) return null;
  if (typeof token !== 'string' || !timingSafeEqual(digest(token), digest(secret))) return null;
  return { phone, linkId: digest(secret).toString('hex').slice(0, 16) };
}

async function setupUser(token) {
  const grant = setupGrant(token);
  if (!grant) throw new HttpError(404, 'not_found');
  const used = await database.queryOne(`SELECT 1 AS used FROM audit_events
    WHERE action = 'admin_setup_link_used' AND target_id = $1`, [grant.linkId]);
  if (used) throw new HttpError(410, 'link_used', 'This setup link has already been used. Sign in with Face ID or fingerprint.');
  // The founder may not have an app account yet on this database; the link is enough proof.
  await database.query('INSERT INTO users(phone) VALUES($1) ON CONFLICT (phone) DO NOTHING', [grant.phone]);
  const user = await database.queryOne('SELECT id, phone FROM users WHERE phone = $1 AND deleted_at IS NULL', [grant.phone]);
  if (!user) throw new HttpError(404, 'not_found');
  return { user, linkId: grant.linkId };
}

export async function setupOptions(token) {
  const { user } = await setupUser(token);
  return registrationOptions(user);
}

export async function finishSetup(token, response, req) {
  const { user, linkId } = await setupUser(token);
  await finishRegistration(user, response);
  await audit({ userId: user.id, action: 'admin_setup_link_used', targetType: 'setup_link', targetId: linkId, req });
  return { token: await openStaffSession(user.id), userId: user.id };
}
