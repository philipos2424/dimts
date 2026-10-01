import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import * as database from '../db/pool.js';
import { resolveUser, hashToken, HttpError } from '../lib/users.js';
import { GOOGLE_SCOPES, googleConfig, googleAuthorization, exchangeGoogleCode,
  encryptIntegration, decryptIntegration } from '../services/google-oauth.js';

export const googleRouter = Router();
export const googleBrowserRouter = Router();
const randomToken = () => randomBytes(32).toString('hex');
const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const kindOf = value => {
  if (!Object.hasOwn(GOOGLE_SCOPES, value ?? '')) throw new HttpError(400, 'invalid_integration');
  return value;
};
const cookieName = state => `dimts_google_${state}`;
function cookieOptions() {
  return { httpOnly: true, secure: googleConfig().secure, sameSite: 'lax', path: '/oauth/google', maxAge: 600000 };
}
googleBrowserRouter.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
  next();
});

googleRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  let configured = true;
  try { googleConfig(); } catch { configured = false; }
  const { rows } = await database.query('SELECT kind,connected_at FROM google_connections WHERE user_id=$1', [user.id]);
  res.json({ configured, connections: rows });
});
googleRouter.post('/start', async (req, res) => {
  const user = await resolveUser(req);
  const kind = kindOf(req.body?.kind), config = googleConfig(), ticket = randomToken();
  await database.withTransaction(async tx => {
    const { rows: [owner] } = await tx.query('UPDATE users SET google_connect_version=google_connect_version+1 WHERE id=$1 RETURNING google_connect_version', [user.id]);
    await tx.query('DELETE FROM google_oauth_requests WHERE user_id=$1 OR expires_at<=now()', [user.id]);
    await tx.query("INSERT INTO google_oauth_requests(token_hash,user_id,kind,phase,version) VALUES($1,$2,$3,'begin',$4)",
      [hashToken(ticket), user.id, kind, owner.google_connect_version]);
  });
  res.json({ url: `${config.origin}/oauth/google/begin?ticket=${ticket}` });
});

googleBrowserRouter.get('/begin', async (req, res) => {
  if (!valid(req.query.ticket)) throw new HttpError(400, 'invalid_google_request');
  const state = randomToken(), nonce = randomToken(), verifier = randomBytes(32).toString('base64url');
  const request = await database.withTransaction(async tx => {
    const { rows: [row] } = await tx.query("DELETE FROM google_oauth_requests WHERE token_hash=$1 AND phase='begin' AND expires_at>now() RETURNING *", [hashToken(req.query.ticket)]);
    if (!row) throw new HttpError(400, 'expired_google_request');
    await tx.query("INSERT INTO google_oauth_requests(token_hash,user_id,kind,phase,version,nonce_hash,encrypted_payload) VALUES($1,$2,$3,'state',$4,$5,$6)",
      [hashToken(state), row.user_id, row.kind, row.version, hashToken(nonce), encryptIntegration({ verifier }, row.user_id)]);
    return row;
  });
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  res.cookie(cookieName(state), nonce, cookieOptions());
  res.redirect(googleAuthorization(request.kind, state, challenge));
});

googleBrowserRouter.get('/callback', async (req, res) => {
  const state = req.query.state;
  if (!valid(state)) throw new HttpError(400, 'invalid_google_request');
  const nonce = (req.get('cookie') ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName(state)}=`))?.split('=')[1];
  if (!valid(nonce)) throw new HttpError(400, 'invalid_google_browser');
  const request = await database.queryOne("DELETE FROM google_oauth_requests WHERE token_hash=$1 AND phase='state' AND nonce_hash=$2 AND expires_at>now() RETURNING *", [hashToken(state), hashToken(nonce)]);
  if (!request) throw new HttpError(400, 'expired_google_request');
  res.clearCookie(cookieName(state), cookieOptions());
  if (req.query.error) return res.type('text').send('Google connection cancelled. Return to Dimts Settings.');
  if (typeof req.query.code !== 'string' || req.query.code.length > 4096) throw new HttpError(400, 'invalid_google_request');
  const { verifier } = decryptIntegration(request.encrypted_payload, request.user_id);
  const tokens = await exchangeGoogleCode(req.query.code, verifier, request.kind);
  const completion = randomToken();
  const result = await database.query(`INSERT INTO google_oauth_requests(token_hash,user_id,kind,phase,version,encrypted_payload)
    SELECT $1,id,$2,'confirm',$3,$4 FROM users WHERE id=$5 AND google_connect_version=$3 RETURNING token_hash`,
    [hashToken(completion), request.kind, request.version, encryptIntegration(tokens, request.user_id), request.user_id]);
  if (!result.rows.length) throw new HttpError(409, 'google_request_superseded');
  // This new secret is available only to the browser that completed consent.
  // A shared begin link cannot attach someone else's Google account silently.
  res.type('text').send(`Google authorized ${request.kind}. To finish, return to Dimts Settings and paste this one-time connection code:\n\n${completion}\n\nExpires in 10 minutes. Do not share it.`);
});

googleRouter.post('/confirm', async (req, res) => {
  const user = await resolveUser(req), code = req.body?.code;
  if (!valid(code)) throw new HttpError(400, 'invalid_connection_code');
  const kind = await database.withTransaction(async tx => {
    const { rows: [owner] } = await tx.query('SELECT google_connect_version FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const { rows: [row] } = await tx.query("DELETE FROM google_oauth_requests WHERE token_hash=$1 AND user_id=$2 AND phase='confirm' AND expires_at>now() AND version=$3 RETURNING *", [hashToken(code), user.id, owner.google_connect_version]);
    if (!row) throw new HttpError(400, 'expired_connection_code');
    await tx.query(`INSERT INTO google_connections(user_id,kind,encrypted_tokens) VALUES($1,$2,$3)
      ON CONFLICT(user_id,kind) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,connected_at=now()`, [user.id, row.kind, row.encrypted_payload]);
    return row.kind;
  });
  res.json({ connected: true, kind });
});
googleRouter.delete('/:kind', async (req, res) => {
  const user = await resolveUser(req), kind = kindOf(req.params.kind);
  await database.withTransaction(async tx => {
    await tx.query('UPDATE users SET google_connect_version=google_connect_version+1 WHERE id=$1', [user.id]);
    await tx.query('DELETE FROM google_oauth_requests WHERE user_id=$1', [user.id]);
    await tx.query('DELETE FROM google_connections WHERE user_id=$1 AND kind=$2', [user.id, kind]);
  });
  res.json({ disconnected: true });
});
