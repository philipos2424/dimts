import { OAuth2Client } from 'google-auth-library';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from '../lib/users.js';
import * as database from '../db/pool.js';

export const GOOGLE_SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.events.owned',
  gmail: 'https://www.googleapis.com/auth/gmail.compose',
};

export function googleConfig() {
  const { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret,
    GOOGLE_OAUTH_REDIRECT_URI: redirect, INTEGRATION_ENCRYPTION_KEY: key } = process.env;
  if (!id || !secret || !redirect || !/^[a-f0-9]{64}$/i.test(key ?? '')) {
    throw new HttpError(503, 'google_not_configured', 'Google connection is not configured on this server.');
  }
  let url;
  try { url = new URL(redirect); } catch { throw new HttpError(503, 'google_not_configured'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !process.env.VERCEL)) ||
      url.pathname !== '/oauth/google/callback' || url.search || url.hash || url.username || url.password) {
    throw new HttpError(503, 'google_not_configured');
  }
  return { id, secret, redirect, origin: url.origin, secure: url.protocol === 'https:', key: Buffer.from(key, 'hex') };
}

export function encryptIntegration(value, owner) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', googleConfig().key, iv);
  cipher.setAAD(Buffer.from(owner));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join('.');
}

export function decryptIntegration(envelope, owner) {
  try {
    const [version, iv, tag, body, extra] = envelope.split('.');
    if (version !== 'v1' || extra || !/^[a-f0-9]{24}$/.test(iv) || !/^[a-f0-9]{32}$/.test(tag) || !/^(?:[a-f0-9]{2})+$/.test(body)) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', googleConfig().key, Buffer.from(iv, 'hex'));
    decipher.setAAD(Buffer.from(owner)); decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'hex')), decipher.final()]).toString('utf8'));
  } catch { throw new HttpError(503, 'integration_unavailable', 'Reconnect Google in Settings.'); }
}

function client() {
  const c = googleConfig();
  return new OAuth2Client({ clientId: c.id, clientSecret: c.secret, redirectUri: c.redirect,
    transporterOptions: { timeout: 15000, retry: false } });
}
export function googleAuthorization(kind, state, challenge) {
  return client().generateAuthUrl({ scope: kind === 'gmail' ? [GOOGLE_SCOPES[kind], 'openid', 'email'] : [GOOGLE_SCOPES[kind]], state,
    access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256' });
}
export async function exchangeGoogleCode(code, verifier, kind) {
  try {
    const auth = client();
    const { tokens } = await auth.getToken({ code, codeVerifier: verifier });
    if (!tokens.access_token || !tokens.refresh_token || !tokens.scope?.split(' ').includes(GOOGLE_SCOPES[kind])) throw new Error();
    if (kind === 'gmail') {
      if (typeof tokens.id_token !== 'string') throw new Error();
      const ticket = await auth.verifyIdToken({ idToken: tokens.id_token, audience: googleConfig().id });
      const identity = ticket.getPayload();
      if (!identity?.sub || identity.email_verified !== true || typeof identity.email !== 'string' ||
        !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(identity.email)) throw new Error();
      tokens.dimts_email = identity.email;
      tokens.dimts_google_subject = identity.sub;
    }
    return tokens;
  } catch { throw new HttpError(400, 'google_authorization_failed', 'Google authorization failed. Start a new connection from Settings.'); }
}
export async function googleSender(userId, connectionId) {
  const row = await database.queryOne("SELECT encrypted_tokens FROM google_connections WHERE user_id=$1 AND kind='gmail' AND connection_id=$2", [userId, connectionId]);
  const identity = row && decryptIntegration(row.encrypted_tokens, userId);
  if (!identity?.dimts_google_subject || !identity.dimts_email || /[\r\n<>]/.test(identity.dimts_email)) throw new HttpError(409, 'gmail_reconnect_required');
  return identity.dimts_email;
}

export async function googleAccessToken(userId, kind, connectionId) {
  const connection = await database.queryOne('SELECT * FROM google_connections WHERE user_id=$1 AND kind=$2 AND connection_id=$3', [userId, kind, connectionId]);
  if (!connection) throw new HttpError(409, 'google_connection_changed', 'Connect the original Google account before checking this action.');
  const credentials = decryptIntegration(connection.encrypted_tokens, userId);
  if (!credentials.scope?.split(' ').includes(GOOGLE_SCOPES[kind])) throw new HttpError(409, 'google_scope_missing');
  const auth = client();
  auth.setCredentials(credentials);
  let token;
  try { ({ token } = await auth.getAccessToken()); }
  catch { throw new HttpError(409, 'google_reconnect_required', 'Reconnect Google in Settings.'); }
  if (typeof token !== 'string' || !token) throw new HttpError(409, 'google_reconnect_required');
  const refreshed = encryptIntegration({ ...credentials, ...auth.credentials }, userId);
  const saved = await database.queryOne(`UPDATE google_connections SET encrypted_tokens=$4
    WHERE user_id=$1 AND kind=$2 AND connection_id=$3 AND encrypted_tokens=$5 RETURNING connection_id`,
    [userId, kind, connectionId, refreshed, connection.encrypted_tokens]);
  if (!saved) throw new HttpError(409, 'google_connection_changed');
  return token;
}
