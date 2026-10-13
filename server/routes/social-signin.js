import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import * as database from '../db/pool.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { hit } from '../lib/rate-limit.js';
import { hashToken, HttpError, resolveUser } from '../lib/users.js';
import { authorizationUrl, completeSignIn, configuredProviders, providerConfig, providerLabel,
  SOCIAL_PROVIDERS, subjectHash } from '../services/social-signin.js';
import { openSession } from './auth.js';
import { defer } from '../lib/defer.js';
import { bindAppleCredential, handleAppleRevocation, queueAppleRevocation, rememberAppleCredential, retryAppleRevocations } from '../services/apple-credentials.js';
import { verifyAppleNotification } from '../services/social-signin.js';

// Sign in with Google, Apple, Telegram or ChatGPT.
//
// Dimts calls the owner's phone, so every account still has a verified mobile
// number. The first social sign-in therefore ends at the phone step: after the
// SMS code, the provider account is linked and later sign-ins (on any device)
// skip SMS entirely.
//
// 1. App   POST /api/auth/social/start   → our /oauth/signin/begin URL
// 2. Browser GET /oauth/signin/begin      → sets a cookie, redirects to the provider
// 3. Browser GET /oauth/signin/:p/callback → checks the cookie + ID token, redirects to the app with a ticket
// 4. App   POST /api/auth/social/finish  → a session, or a link ticket for /api/auth/verify
//
// The ticket in step 3 travels through a URL another app could intercept, so
// redeeming it needs the PKCE-style verifier only the starting app holds.

export const socialRouter = express.Router();
export const socialBrowserRouter = express.Router();
export const signInMethodsRouter = express.Router();

const randomToken = () => randomBytes(32).toString('hex');
const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cookieName = state => `dimts_signin_${state}`;
const secure = () => config.publicBaseUrl.startsWith('https:');
const cookieOptions = () => ({ httpOnly: true, secure: secure(), sameSite: 'lax', path: '/oauth/signin', maxAge: 600_000 });
const limit = (key, maximum) => hit(key, maximum, 3600);
const local = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);

/** Where the browser may hand the ticket back: the app's own scheme or the web app's sign-in page. */
export function allowedReturn(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.hash || value.length > 300) return null;
  url.search = '';
  const development = !process.env.VERCEL && process.env.NODE_ENV !== 'production';
  if (url.protocol === 'dimts:' && (url.host === 'onboarding' && !url.pathname || !url.host && url.pathname === '/onboarding')) return url.toString();
  if (url.protocol === 'exp:' && development) return url.toString(); // Expo Go
  if (url.protocol === 'https:' && url.origin === new URL(config.publicBaseUrl).origin && url.pathname === '/onboarding') return url.toString();
  if (url.protocol === 'http:' && development && local(url.hostname) && url.pathname === '/onboarding') return url.toString();
  return null;
}

socialRouter.get('/providers', (_req, res) => {
  res.json({ providers: configuredProviders() });
});

socialRouter.post('/start', async (req, res) => {
  const { provider: name, challenge, return_to: returnTo } = req.body ?? {};
  const provider = providerConfig(name);
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new HttpError(400, 'invalid_social_request');
  const back = allowedReturn(returnTo);
  if (!back) throw new HttpError(400, 'invalid_return_url');
  await limit(`social-start-ip:${req.ip}`, 30);
  const ticket = randomToken();
  await query('DELETE FROM social_signin_requests WHERE expires_at <= now()');
  await query(`INSERT INTO social_signin_requests(token_hash,phase,provider,app_challenge,return_to)
    VALUES($1,'begin',$2,$3,$4)`, [hashToken(ticket), provider.name, challenge, back]);
  res.set('Cache-Control', 'no-store').json({ url: `${config.publicBaseUrl}/oauth/signin/begin?ticket=${ticket}` });
});

socialBrowserRouter.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
  next();
});

socialBrowserRouter.get('/begin', async (req, res) => {
  if (!valid(req.query.ticket)) throw new HttpError(400, 'invalid_social_request');
  const begun = await queryOne(`DELETE FROM social_signin_requests WHERE token_hash=$1 AND phase='begin' AND expires_at>now()
    RETURNING provider, app_challenge, return_to`, [hashToken(req.query.ticket)]);
  if (!begun) throw new HttpError(400, 'expired_social_request');
  const provider = providerConfig(begun.provider);
  // The PKCE verifier and nonce derive from this secret, which lives only in
  // the browser that started; the database keeps its hash.
  const state = randomToken(), secret = randomToken();
  await query(`INSERT INTO social_signin_requests(token_hash,phase,provider,app_challenge,return_to,cookie_hash)
    VALUES($1,'state',$2,$3,$4,$5)`, [hashToken(state), provider.name, begun.app_challenge, begun.return_to, hashToken(secret)]);
  let target;
  try { target = await authorizationUrl(provider, state, secret); }
  catch (err) {
    console.error(`[social-signin] ${provider.name} is unreachable:`, err?.message);
    const back = new URL(begun.return_to);
    back.searchParams.set('social_error', 'failed');
    return res.redirect(back.toString());
  }
  res.cookie(cookieName(state), secret, cookieOptions());
  res.redirect(target);
});

socialBrowserRouter.get('/:provider/callback', async (req, res) => {
  const state = req.query.state;
  if (!valid(state) || !SOCIAL_PROVIDERS.includes(req.params.provider)) throw new HttpError(400, 'invalid_social_request');
  const secret = (req.get('cookie') ?? '').split(';').map(s => s.trim())
    .find(s => s.startsWith(`${cookieName(state)}=`))?.split('=')[1];
  if (!valid(secret)) throw new HttpError(400, 'invalid_social_browser', 'Open Dimts and start signing in again.');
  const request = await queryOne(`DELETE FROM social_signin_requests WHERE token_hash=$1 AND phase='state' AND provider=$2
    AND cookie_hash=$3 AND expires_at>now() RETURNING *`, [hashToken(state), req.params.provider, hashToken(secret)]);
  if (!request) throw new HttpError(400, 'expired_social_request', 'Open Dimts and start signing in again.');
  res.clearCookie(cookieName(state), cookieOptions());
  const back = params => {
    const url = new URL(request.return_to);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    res.redirect(url.toString());
  };
  if (req.query.error) return back({ social_error: 'cancelled' });
  if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) return back({ social_error: 'failed' });
  const provider = providerConfig(request.provider);
  let identity;
  try {
    identity = await completeSignIn(provider, req.query.code, secret);
    if (provider.name === 'apple') await rememberAppleCredential(identity);
  }
  catch { return back({ social_error: 'failed' }); }
  const completion = randomToken();
  await query(`INSERT INTO social_signin_requests(token_hash,phase,provider,app_challenge,subject_hash,phone_hint,expires_at)
    VALUES($1,'done',$2,$3,$4,$5,now() + interval '5 minutes')`,
  [hashToken(completion), provider.name, request.app_challenge, subjectHash(provider.name, identity.subject), identity.phone]);
  back({ social: completion });
});

socialRouter.post('/finish', async (req, res) => {
  const { ticket, verifier } = req.body ?? {};
  if (!valid(ticket) || typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) {
    throw new HttpError(400, 'invalid_social_request');
  }
  await limit(`social-finish-ip:${req.ip}`, 40);
  const done = await queryOne(`DELETE FROM social_signin_requests WHERE token_hash=$1 AND phase='done' AND expires_at>now()
    RETURNING provider, app_challenge, subject_hash, phone_hint`, [hashToken(ticket)]);
  if (!done || createHash('sha256').update(verifier).digest('base64url') !== done.app_challenge) {
    throw new HttpError(400, 'expired_social_request', 'Sign-in expired. Try again.');
  }
  const user = await queryOne(`UPDATE user_identities i SET last_used_at=now() FROM users u
    WHERE i.provider=$1 AND i.subject_hash=$2 AND u.id=i.user_id AND u.deleted_at IS NULL
    RETURNING u.id, u.phone, u.tier, u.terms_version`, [done.provider, done.subject_hash]);
  if (user) {
    if (done.provider === 'apple') await bindAppleCredential(database, done.subject_hash);
    return openSession(req, res, user, { method: done.provider });
  }
  // First time with this account: confirm the mobile number once, then link.
  const link = randomToken();
  await query(`INSERT INTO social_signin_requests(token_hash,phase,provider,subject_hash,expires_at)
    VALUES($1,'link',$2,$3,now() + interval '30 minutes')`, [hashToken(link), done.provider, done.subject_hash]);
  res.status(202).set('Cache-Control', 'no-store').json({
    status: 'phone_required', link, provider: done.provider, label: providerLabel(done.provider), phone: done.phone_hint ?? null,
  });
});

/** Called by /api/auth/verify once the phone code checks out. */
export async function linkIdentity(userId, link, req) {
  const provider = await database.withTransaction(async tx => {
    const { rows: [user] } = await tx.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [userId]);
    if (!user) throw new HttpError(401, 'session_expired');
    const { rows: [row] } = await tx.query(`DELETE FROM social_signin_requests WHERE token_hash=$1 AND phase='link' AND expires_at>now()
      RETURNING provider, subject_hash`, [hashToken(link)]);
    if (!row) throw new HttpError(400, 'expired_social_request', 'Your sign-in link expired. Start signing in again.');
    const { rows: [saved] } = await tx.query(`INSERT INTO user_identities(provider,subject_hash,user_id,last_used_at) VALUES($1,$2,$3,now())
      ON CONFLICT (provider, subject_hash) DO UPDATE SET last_used_at=now()
      WHERE user_identities.user_id=EXCLUDED.user_id RETURNING provider`, [row.provider, row.subject_hash, userId]);
    if (!saved) throw new HttpError(409, 'identity_already_linked', 'This sign-in account is linked to another mobile number.');
    if (row.provider === 'apple') await bindAppleCredential(tx, row.subject_hash);
    return saved.provider;
  });
  await audit({ userId, action: 'sign_in_method_linked', targetType: 'provider', targetId: provider, req });
  return provider;
}

// Settings › Sign-in methods.
signInMethodsRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  const { rows } = await query(`SELECT provider, min(created_at) AS created_at, max(last_used_at) AS last_used_at
    FROM user_identities WHERE user_id=$1 GROUP BY provider ORDER BY provider`, [user.id]);
  res.set('Cache-Control', 'no-store').json({ methods: rows, available: configuredProviders() });
});

signInMethodsRouter.delete('/:provider', async (req, res) => {
  const user = await resolveUser(req);
  if (!SOCIAL_PROVIDERS.includes(req.params.provider)) throw new HttpError(404, 'sign_in_method_not_found');
  const { rows } = await database.withTransaction(async tx => {
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    if (req.params.provider === 'apple') await queueAppleRevocation(tx, user.id);
    return tx.query('DELETE FROM user_identities WHERE user_id=$1 AND provider=$2 RETURNING provider', [user.id, req.params.provider]);
  });
  if (!rows.length) throw new HttpError(404, 'sign_in_method_not_found');
  await audit({ userId: user.id, action: 'sign_in_method_removed', targetType: 'provider', targetId: req.params.provider, req });
  if (req.params.provider === 'apple') defer(retryAppleRevocations(), 'apple-revocation');
  res.json({ status: 'removed' });
});

socialBrowserRouter.post('/apple/notifications', async (req, res) => {
  const event = await verifyAppleNotification(req.body?.payload);
  await handleAppleRevocation(event);
  res.sendStatus(200);
});
