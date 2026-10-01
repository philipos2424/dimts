import { OAuth2Client } from 'google-auth-library';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from '../lib/users.js';

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
  return client().generateAuthUrl({ scope: [GOOGLE_SCOPES[kind]], state,
    access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256' });
}
export async function exchangeGoogleCode(code, verifier, kind) {
  try {
    const { tokens } = await client().getToken({ code, codeVerifier: verifier });
    if (!tokens.access_token || !tokens.refresh_token || !tokens.scope?.split(' ').includes(GOOGLE_SCOPES[kind])) throw new Error();
    return tokens;
  } catch { throw new HttpError(400, 'google_authorization_failed', 'Google authorization failed. Start a new connection from Settings.'); }
}
