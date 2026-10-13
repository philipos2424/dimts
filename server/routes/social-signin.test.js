import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const codes = [];
mock.module('../services/verify-phone.js', { namedExports: {
  sendPhoneCode: async phone => { codes.push(phone); },
  checkPhoneCode: async (_phone, code) => code === '123456',
} });
mock.module('../services/sign-in-alert.js', { namedExports: { sendNewSignInNotification: async () => {} } });

Object.assign(process.env, {
  GOOGLE_OAUTH_CLIENT_ID: 'google-client', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
  TELEGRAM_LOGIN_CLIENT_ID: '777000', TELEGRAM_LOGIN_CLIENT_SECRET: 'telegram-secret',
});
delete process.env.APPLE_SIGNIN_SERVICE_ID; delete process.env.OPENAI_SIGNIN_CLIENT_ID;

// A fake identity provider that signs real RS256 ID tokens.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const ISSUERS = { 'accounts.google.com': 'https://accounts.google.com', 'oauth.telegram.org': 'https://oauth.telegram.org' };
Object.assign(ISSUERS, { 'appleid.apple.com': 'https://appleid.apple.com', 'auth.openai.com': 'https://auth.openai.com' });
let revokeStatus = 200;
const revocations = [];
const provider = { subject: 'user-1', nonce: null, forcedNonce: null, claims: {}, key: privateKey, tokenRequests: [] };
function idToken(claims, key = provider.key) {
  const body = [{ alg: 'RS256', kid: 'k1' }, claims].map(p => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.');
  return `${body}.${sign('sha256', Buffer.from(body), key).toString('base64url')}`;
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const issuer = ISSUERS[url.hostname];
  if (!issuer) return realFetch(input, init);
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/.well-known/openid-configuration') return json({
    issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
  });
  if (url.pathname === '/jwks') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] });
  if (url.pathname === '/auth/revoke') {
    revocations.push(new URLSearchParams(String(init.body)));
    return new Response('', { status: revokeStatus });
  }
  if (url.pathname === '/token') {
    const body = new URLSearchParams(String(init.body));
    provider.tokenRequests.push({ body, headers: init.headers });
    if (body.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
    const aud = ({ 'oauth.telegram.org': '777000', 'appleid.apple.com': 'apple-client', 'auth.openai.com': 'openai-client' })[url.hostname] ?? 'google-client';
    return json({ id_token: idToken({ iss: issuer, aud, sub: provider.subject, nonce: provider.nonce ?? undefined,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...provider.claims }),
      ...(url.hostname === 'appleid.apple.com' ? { refresh_token: 'apple-private-refresh-token' } : {}) });
  }
  return new Response('not found', { status: 404 });
};

const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
process.env.PUBLIC_BASE_URL = origin;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); globalThis.fetch = realFetch; });
test.beforeEach(async () => {
  Object.assign(provider, { subject: 'user-1', nonce: null, forcedNonce: null, claims: {}, key: privateKey, tokenRequests: [] });
  revokeStatus = 200; revocations.length = 0;
  await db.exec('DELETE FROM user_identities; DELETE FROM apple_signin_events; DELETE FROM apple_signin_credentials; DELETE FROM social_signin_requests; DELETE FROM rate_limits; DELETE FROM sessions;');
});

const api = (path, body, token) => realFetch(origin + path, {
  method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

const RETURN = 'dimts://onboarding';
/** Runs the browser half and returns the app-side ticket (or error) from the final redirect. */
async function browserFlow(name = 'google', { code = 'good-code', verifier = randomBytes(32).toString('base64url'), cookie = true } = {}) {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const started = await api('/api/auth/social/start', { provider: name, challenge, return_to: RETURN });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const begin = await realFetch(started.body.url, { redirect: 'manual' });
  assert.equal(begin.status, 302);
  const target = new URL(begin.headers.get('location'));
  provider.nonce = provider.forcedNonce ?? target.searchParams.get('nonce');
  const jar = begin.headers.get('set-cookie').split(';')[0];
  const callback = await realFetch(`${origin}/oauth/signin/${name}/callback?state=${target.searchParams.get('state')}&code=${code}`,
    { redirect: 'manual', headers: cookie ? { cookie: jar } : {} });
  if (callback.status !== 302) return { status: callback.status, target };
  const back = new URL(callback.headers.get('location'));
  return { back, ticket: back.searchParams.get('social'), error: back.searchParams.get('social_error'), verifier, target };
}

test('only configured providers are offered', async () => {
  assert.deepEqual((await api('/api/auth/social/providers')).body.providers, ['google', 'telegram']);
  assert.equal((await api('/api/auth/social/start', { provider: 'apple', challenge: 'a'.repeat(43), return_to: RETURN })).status, 503);
});

test('first Google sign-in confirms the phone once; the next one needs no SMS', async () => {
  const first = await browserFlow();
  assert.equal(`${first.back.protocol}//${first.back.host}${first.back.pathname}`, RETURN);
  assert.equal(first.target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(first.target.searchParams.get('redirect_uri'), `${origin}/oauth/signin/google/callback`);
  const pending = await api('/api/auth/social/finish', { ticket: first.ticket, verifier: first.verifier });
  assert.equal(pending.status, 202);
  assert.equal(pending.body.status, 'phone_required');
  assert.equal(pending.body.token, undefined);

  const verified = await api('/api/auth/verify', { phone: '+14155550101', code: '123456', link: pending.body.link });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.linked, 'google');
  const stored = (await db.query('SELECT provider, subject_hash FROM user_identities')).rows;
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].subject_hash, 'user-1'); // only a hash of the provider's ID

  codes.length = 0;
  const second = await browserFlow();
  const signedIn = await api('/api/auth/social/finish', { ticket: second.ticket, verifier: second.verifier });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.phone, '+14155550101');
  assert.match(signedIn.body.token, /^[a-f0-9]{64}$/);
  assert.equal(codes.length, 0);
  assert.equal((await api('/api/me/sign-in-methods', undefined, signedIn.body.token)).body.methods[0].provider, 'google');
});

test('a ticket is useless without the verifier of the app that started, and works only once', async () => {
  const flow = await browserFlow();
  const stolen = await api('/api/auth/social/finish', { ticket: flow.ticket, verifier: randomBytes(32).toString('base64url') });
  assert.equal(stolen.status, 400);
  // The failed attempt burned the ticket.
  assert.equal((await api('/api/auth/social/finish', { ticket: flow.ticket, verifier: flow.verifier })).status, 400);
});

test('the callback needs the browser cookie from begin', async () => {
  const flow = await browserFlow('google', { cookie: false });
  assert.equal(flow.status, 400);
});

test('forged, mis-nonced or refused tokens never sign anyone in', async () => {
  provider.key = rogue;
  assert.equal((await browserFlow()).error, 'failed');
  provider.key = privateKey; provider.forcedNonce = 'someone-elses-nonce';
  assert.equal((await browserFlow()).error, 'failed');
  provider.forcedNonce = null;
  assert.equal((await browserFlow('google', { code: 'bad-code' })).error, 'failed');
  provider.claims = { aud: 'another-app' };
  assert.equal((await browserFlow()).error, 'failed');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM social_signin_requests WHERE phase='done'")).rows[0].n, 0);
});

test('tickets only go back to the app or the Dimts sign-in page', async () => {
  const challenge = 'a'.repeat(43);
  for (const target of ['https://evil.example/onboarding', `${origin}/settings`, 'javascript:alert(1)', 'dimts://x#frag']) {
    const r = await api('/api/auth/social/start', { provider: 'google', challenge, return_to: target });
    assert.equal(r.status, 400, target);
  }
});

test('Telegram uses basic auth and suggests the account phone, which is still confirmed by SMS', async () => {
  provider.claims = { phone_number: '14155550177' };
  const flow = await browserFlow('telegram');
  assert.match(provider.tokenRequests[0].headers.authorization, /^Basic /);
  assert.equal(provider.tokenRequests[0].body.get('client_secret'), null);
  const pending = await api('/api/auth/social/finish', { ticket: flow.ticket, verifier: flow.verifier });
  assert.equal(pending.status, 202);
  assert.equal(pending.body.phone, '+14155550177');
});

test('removing the method or deleting the account unlinks it', async () => {
  const flow = await browserFlow();
  const pending = await api('/api/auth/social/finish', { ticket: flow.ticket, verifier: flow.verifier });
  const session = await api('/api/auth/verify', { phone: '+14155550102', code: '123456', link: pending.body.link });
  const removed = await realFetch(`${origin}/api/me/sign-in-methods/google`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.body.token}` } });
  assert.equal(removed.status, 200);
  const again = await browserFlow();
  assert.equal((await api('/api/auth/social/finish', { ticket: again.ticket, verifier: again.verifier })).status, 202);

  const { deleteAccount } = await import('../services/delete-account.js');
  const relink = await browserFlow();
  const link = (await api('/api/auth/social/finish', { ticket: relink.ticket, verifier: relink.verifier })).body.link;
  const user = (await api('/api/auth/verify', { phone: '+14155550103', code: '123456', link })).body;
  assert.equal(user.linked, 'google');
  const owner = (await db.query("SELECT id FROM users WHERE phone='+14155550103'")).rows[0];
  await deleteAccount(owner.id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM user_identities WHERE user_id=$1', [owner.id])).rows[0].n, 0);
});
test('an expired link must not silently report successful social onboarding', async () => {
  const flow = await browserFlow();
  const pending = await api('/api/auth/social/finish', { ticket: flow.ticket, verifier: flow.verifier });
  await db.exec("UPDATE social_signin_requests SET expires_at=now()-interval '1 second' WHERE phase='link'");
  const result = await api('/api/auth/verify', { phone: '+14155550181', code: '123456', link: pending.body.link });
  assert.equal(result.status, 400, `Expected expired-link error; got status ${result.status}, linked=${result.body.linked}`);
  assert.equal((await db.query('SELECT * FROM sessions')).rows.length, 0);
});

test('a conflicting pending link must not silently sign in another phone', async () => {
  const one = await browserFlow();
  const first = await api('/api/auth/social/finish', { ticket: one.ticket, verifier: one.verifier });
  const two = await browserFlow();
  const second = await api('/api/auth/social/finish', { ticket: two.ticket, verifier: two.verifier });
  assert.equal((await api('/api/auth/verify', { phone: '+14155550182', code: '123456', link: first.body.link })).body.linked, 'google');
  const result = await api('/api/auth/verify', { phone: '+14155550183', code: '123456', link: second.body.link });
  assert.equal(result.status, 409, `Expected identity-conflict error; got status ${result.status}, linked=${result.body.linked}`);
  assert.equal((await db.query('SELECT * FROM sessions')).rows.length, 1);
});

async function withApple(work) {
  const privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  Object.assign(process.env, { APPLE_SIGNIN_SERVICE_ID: 'apple-client', APPLE_TEAM_ID: 'TEAM', APPLE_KEY_ID: 'KEY',
    APPLE_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).replace(/\n/g, '\\n'), INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32) });
  try { await work(); } finally {
    for (const name of ['APPLE_SIGNIN_SERVICE_ID','APPLE_TEAM_ID','APPLE_KEY_ID','APPLE_PRIVATE_KEY','INTEGRATION_ENCRYPTION_KEY']) delete process.env[name];
  }
}

async function linkApple(phone) {
  const flow = await browserFlow('apple');
  assert.ok(flow.ticket, JSON.stringify(flow));
  assert.equal(flow.target.searchParams.get('response_type'), 'code');
  assert.equal(flow.target.searchParams.get('scope'), null);
  const pending = await api('/api/auth/social/finish', { ticket: flow.ticket, verifier: flow.verifier });
  const session = await api('/api/auth/verify', { phone, code: '123456', link: pending.body.link });
  assert.equal(session.body.linked, 'apple');
  return session.body;
}

test('Apple keeps an encrypted revocable grant; returning sign-in skips SMS and deletion retries failures', async () => withApple(async () => {
  const session = await linkApple('+14155550184');
  const stored = (await db.query('SELECT * FROM apple_signin_credentials')).rows[0];
  assert.ok(stored.encrypted_token.startsWith('v1.'));
  assert.ok(!stored.encrypted_token.includes('apple-private-refresh-token'));
  assert.equal(stored.revoke_after, null);
  const flow = await browserFlow('apple');
  assert.equal((await api('/api/auth/social/finish', { ticket: flow.ticket, verifier: flow.verifier })).body.phone, session.phone);
  revokeStatus = 503;
  const owner = (await db.query('SELECT id FROM users WHERE phone=$1', [session.phone])).rows[0];
  await (await import('../services/delete-account.js')).deleteAccount(owner.id);
  await (await import('../lib/defer.js')).drainDeferredWork();
  const { retryAppleRevocations } = await import('../services/apple-credentials.js');
  await retryAppleRevocations();
  assert.equal((await db.query('SELECT * FROM user_identities WHERE user_id=$1', [owner.id])).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM sessions WHERE user_id=$1', [owner.id])).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM apple_signin_credentials')).rows.length, 1);
  revokeStatus = 200;
  await db.exec("UPDATE apple_signin_credentials SET next_attempt_at=now(),lease_until=now()-interval '1 second'");
  assert.equal((await retryAppleRevocations()).revoked, 1);
  assert.equal(revocations.at(-1).get('token'), 'apple-private-refresh-token');
  assert.equal(revocations.at(-1).get('token_type_hint'), 'refresh_token');
  assert.equal((await db.query('SELECT * FROM apple_signin_credentials')).rows.length, 0);
}));

test('removing Apple queues revocation and concurrent workers do not dispatch it twice', async () => withApple(async () => {
  const session = await linkApple('+14155550186');
  const removed = await realFetch(`${origin}/api/me/sign-in-methods/apple`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal(removed.status, 200);
  await (await import('../lib/defer.js')).drainDeferredWork();
  assert.equal(revocations.length, 1);
  assert.equal((await db.query('SELECT * FROM apple_signin_credentials')).rows.length, 0);
  // A second pending grant is cleaned up by exactly one worker.
  assert.ok((await browserFlow('apple')).ticket);
  await db.exec("UPDATE apple_signin_credentials SET revoke_after=now()-interval '1 second'");
  const { retryAppleRevocations } = await import('../services/apple-credentials.js');
  const results = await Promise.all([retryAppleRevocations(), retryAppleRevocations()]);
  assert.equal(results.reduce((total, result) => total + result.revoked, 0), 1);
  assert.equal(revocations.length, 2);
}));

test('abandoned Apple authorization expires and is revoked without creating a user', async () => withApple(async () => {
  assert.ok((await browserFlow('apple')).ticket);
  const { retryAppleRevocations } = await import('../services/apple-credentials.js');
  assert.equal((await retryAppleRevocations()).revoked, 0);
  await db.exec("UPDATE apple_signin_credentials SET revoke_after=now()-interval '1 second'");
  assert.equal((await retryAppleRevocations()).revoked, 1);
  assert.equal((await db.query("SELECT * FROM user_identities WHERE provider='apple'")).rows.length, 0);
}));

test('signed Apple revocation removes access; forged and stale events cannot unlink a newer grant', async () => withApple(async () => {
  const session = await linkApple('+14155550185');
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: ISSUERS['appleid.apple.com'], aud: 'apple-client', iat: now, jti: 'event-id',
    events: JSON.stringify({ type: 'consent-revoked', sub: provider.subject, event_time: now }) };
  assert.equal((await api('/oauth/signin/apple/notifications', { payload: idToken(claims, rogue) })).status, 400);
  const stale = { ...claims, jti: 'old-event-id', events: JSON.stringify({ type: 'consent-revoked', sub: provider.subject, event_time: now - 60 }) };
  assert.equal((await api('/oauth/signin/apple/notifications', { payload: idToken(stale) })).status, 200);
  assert.equal((await api('/api/me/sign-in-methods', undefined, session.token)).status, 200);
  assert.equal((await api('/oauth/signin/apple/notifications', { payload: idToken(claims) })).status, 200);
  assert.equal((await api('/api/me/sign-in-methods', undefined, session.token)).status, 401);
  assert.equal((await db.query('SELECT * FROM apple_signin_credentials')).rows.length, 0);
  assert.equal((await api('/oauth/signin/apple/notifications', { payload: idToken(claims) })).status, 200);
  const { rememberAppleCredential } = await import('../services/apple-credentials.js');
  await assert.rejects(rememberAppleCredential({ subject: provider.subject, refreshToken: 'stale', authorizedAt: now }), { code: 'apple_revocation_pending' });
  provider.claims = { iat: now + 1 };
  const newSession = await linkApple('+14155550185');
  assert.equal((await api('/oauth/signin/apple/notifications', { payload: idToken(claims) })).status, 200);
  assert.equal((await api('/api/me/sign-in-methods', undefined, newSession.token)).status, 200);
}));

test('ChatGPT public and confidential client flows verify identity and retain the app challenge', async () => {
  process.env.OPENAI_SIGNIN_CLIENT_ID = 'openai-client';
  try {
    for (const confidential of [false, true]) {
      if (confidential) process.env.OPENAI_SIGNIN_CLIENT_SECRET = 'test-secret';
      else delete process.env.OPENAI_SIGNIN_CLIENT_SECRET;
      const flow = await browserFlow('chatgpt');
      assert.ok(flow.ticket);
      assert.equal(flow.target.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(Boolean(provider.tokenRequests.at(-1).headers.authorization), confidential);
      assert.equal((await api('/api/auth/social/finish', { ticket: flow.ticket, verifier: flow.verifier })).status, 202);
    }
  } finally { delete process.env.OPENAI_SIGNIN_CLIENT_ID; delete process.env.OPENAI_SIGNIN_CLIENT_SECRET; }
});
