import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/users.js';

// Sign in with Google, Apple, Telegram and ChatGPT. All four are OpenID Connect
// providers, so one authorization-code flow covers them: endpoints come from
// each provider's discovery document and every ID token is checked against the
// provider's published keys. Dimts keeps only a hash of the provider's subject
// ID: no name, email or profile picture is stored.

const PROVIDERS = {
  google: {
    label: 'Google',
    discovery: 'https://accounts.google.com/.well-known/openid-configuration',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid', pkce: true, nonce: true, auth: 'post',
    credentials: () => pair('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'),
  },
  // No scope: Apple then sends the code back by plain redirect instead of a
  // form post, and Dimts never receives the name or email anyway.
  apple: {
    label: 'Apple',
    discovery: 'https://appleid.apple.com/.well-known/openid-configuration',
    issuers: ['https://appleid.apple.com'],
    scope: null, pkce: false, nonce: true, auth: 'post',
    credentials: appleCredentials,
  },
  // The phone scope lets Telegram fill in the number; it is still confirmed by SMS.
  telegram: {
    label: 'Telegram',
    discovery: 'https://oauth.telegram.org/.well-known/openid-configuration',
    issuers: ['https://oauth.telegram.org'],
    scope: 'openid phone', pkce: true, nonce: false, auth: 'basic',
    credentials: () => pair('TELEGRAM_LOGIN_CLIENT_ID', 'TELEGRAM_LOGIN_CLIENT_SECRET'),
  },
  chatgpt: {
    label: 'ChatGPT',
    discovery: 'https://auth.openai.com/.well-known/openid-configuration',
    issuers: ['https://auth.openai.com'],
    // Confidential clients authenticate with Basic; public ones send no secret.
    scope: 'openid', pkce: true, nonce: true, auth: 'basic',
    // From OpenAI's docs, for when the discovery document is unreachable.
    fallback: {
      authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
      token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
      jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
    },
    credentials: () => pair('OPENAI_SIGNIN_CLIENT_ID', 'OPENAI_SIGNIN_CLIENT_SECRET', { secretOptional: true }),
  },
};
export const SOCIAL_PROVIDERS = Object.keys(PROVIDERS);

function pair(idName, secretName, { secretOptional = false } = {}) {
  const id = process.env[idName], secret = process.env[secretName];
  if (!id || (!secret && !secretOptional)) return null;
  return { id, secret: secret || null };
}

/** Apple's client secret is a short-lived ES256 JWT signed with the .p8 key. */
function appleCredentials() {
  const { APPLE_SIGNIN_SERVICE_ID: id, APPLE_TEAM_ID: team, APPLE_KEY_ID: kid, APPLE_PRIVATE_KEY: pem } = process.env;
  if (!id || !team || !kid || !pem) return null;
  return {
    id,
    get secret() {
      const now = Math.floor(Date.now() / 1000);
      const body = [{ alg: 'ES256', kid }, { iss: team, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: id }]
        .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
      const key = createPrivateKey(pem.replace(/\\n/g, '\n'));
      return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    },
  };
}

export function providerLabel(name) { return PROVIDERS[name]?.label ?? name; }

/** The providers whose credentials are set, in display order. */
export function configuredProviders() {
  return SOCIAL_PROVIDERS.filter(name => {
    try { return !!PROVIDERS[name].credentials(); } catch { return false; }
  });
}

export function providerConfig(name) {
  const provider = Object.hasOwn(PROVIDERS, name ?? '') ? PROVIDERS[name] : null;
  if (!provider) throw new HttpError(400, 'invalid_provider');
  const credentials = provider.credentials();
  if (!credentials) throw new HttpError(503, 'provider_not_configured', `Sign in with ${provider.label} is not available yet.`);
  return { name, ...provider, credentials, redirect: `${config.publicBaseUrl}/oauth/signin/${name}/callback` };
}

// Discovery documents and key sets change rarely; an unknown key ID refetches.
const cache = new Map();
async function fetchJson(url, { fresh = false } = {}) {
  const hit = cache.get(url);
  if (!fresh && hit && hit.at > Date.now() - 3600_000) return hit.value;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const value = await response.json();
  cache.set(url, { at: Date.now(), value });
  return value;
}
export function clearProviderCache() { cache.clear(); }

async function metadata(provider) {
  let meta;
  try { meta = await fetchJson(provider.discovery); }
  catch (err) { if (!provider.fallback) throw err; meta = provider.fallback; }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof meta[field] !== 'string' || !meta[field].startsWith('https://')) throw new Error(`discovery is missing ${field}`);
  }
  return meta;
}

/** PKCE verifier and ID-token nonce, both derived from the one secret kept in the browser cookie. */
export const pkceVerifier = secret => createHash('sha256').update(`pkce:${secret}`).digest('base64url');
export const nonceFor = secret => createHash('sha256').update(`nonce:${secret}`).digest('hex');

export async function authorizationUrl(provider, state, secret) {
  const url = new URL((await metadata(provider)).authorization_endpoint);
  const params = { client_id: provider.credentials.id, redirect_uri: provider.redirect, response_type: 'code', state };
  if (provider.scope) params.scope = provider.scope;
  if (provider.nonce) params.nonce = nonceFor(secret);
  if (provider.pkce) Object.assign(params, {
    code_challenge: createHash('sha256').update(pkceVerifier(secret)).digest('base64url'), code_challenge_method: 'S256',
  });
  if (provider.name === 'google') params.prompt = 'select_account';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Trade the code for an ID token and check it. Returns the provider's stable
 * subject ID and, from Telegram, the account's phone number when shared.
 */
export async function completeSignIn(provider, code, secret) {
  try {
    const meta = await metadata(provider);
    const { id, secret: clientSecret } = provider.credentials;
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: provider.redirect });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (provider.pkce) body.set('code_verifier', pkceVerifier(secret));
    if (provider.auth === 'basic' && clientSecret) headers.authorization = `Basic ${Buffer.from(`${id}:${clientSecret}`).toString('base64')}`;
    else { body.set('client_id', id); if (clientSecret) body.set('client_secret', clientSecret); }
    const response = await fetch(meta.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok || typeof tokens.id_token !== 'string') throw new Error(`token endpoint returned ${response.status}`);
    const claims = await verifyIdToken(tokens.id_token, provider, meta, provider.nonce ? nonceFor(secret) : null);
    return { subject: String(claims.sub), phone: provider.name === 'telegram' ? telegramPhone(claims) : null };
  } catch (err) {
    console.error(`[social-signin] ${provider.name} sign-in failed:`, err?.message);
    throw new HttpError(400, 'social_signin_failed', `Sign in with ${provider.label} failed. Try again.`);
  }
}

function telegramPhone(claims) {
  const digits = String(claims.phone_number ?? '').replace(/^\+/, '');
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const ALGORITHMS = { RS256: { kty: 'RSA' }, ES256: { kty: 'EC', crv: 'P-256' } };

export async function verifyIdToken(token, provider, meta, expectedNonce) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const [header, claims] = [decode(parts[0]), decode(parts[1])];
  const algorithm = ALGORITHMS[header.alg];
  if (!algorithm) throw new Error(`unsupported id_token algorithm ${header.alg}`);
  const find = set => (set.keys ?? []).find(k => k.kid === header.kid && k.kty === algorithm.kty && (!algorithm.crv || k.crv === algorithm.crv));
  const jwk = find(await fetchJson(meta.jwks_uri)) ?? find(await fetchJson(meta.jwks_uri, { fresh: true }));
  if (!jwk) throw new Error('no matching signing key');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verify('sha256', signed, header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, signature)) {
    throw new Error('bad id_token signature');
  }
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const clientId = provider.credentials.id;
  if (!provider.issuers.includes(claims.iss)) throw new Error('wrong issuer');
  if (!audiences.map(String).includes(String(clientId))) throw new Error('wrong audience');
  if (audiences.length > 1 && claims.azp !== clientId) throw new Error('wrong authorized party');
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('expired id_token');
  if (typeof claims.iat === 'number' && claims.iat > now + 300) throw new Error('id_token from the future');
  if (expectedNonce && claims.nonce !== expectedNonce) throw new Error('wrong nonce');
  if (claims.sub === undefined || claims.sub === null || String(claims.sub) === '') throw new Error('missing subject');
  return claims;
}

/** What the account table stores instead of the provider's raw ID. */
export const subjectHash = (provider, subject) => createHash('sha256').update(`${provider}:${subject}`).digest('hex');
