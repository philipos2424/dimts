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
  if (url.pathname === '/token') {
    const body = new URLSearchParams(String(init.body));
    provider.tokenRequests.push({ body, headers: init.headers });
    if (body.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
    const aud = url.hostname === 'oauth.telegram.org' ? '777000' : 'google-client';
    return json({ id_token: idToken({ iss: issuer, aud, sub: provider.subject, nonce: provider.nonce ?? undefined,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...provider.claims }) });
  }
  return new Response('not found', { status: 404 });
};

const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
process.env.PUBLIC_BASE_URL = origin;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); globalThis.fetch = realFetch; });
test.beforeEach(async () => {
  Object.assign(provider, { subject: 'user-1', nonce: null, forcedNonce: null, claims: {}, key: privateKey, tokenRequests: [] });
  await db.exec('DELETE FROM user_identities; DELETE FROM social_signin_requests; DELETE FROM rate_limits; DELETE FROM sessions;');
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
