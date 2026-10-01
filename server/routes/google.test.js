import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://127.0.0.1:3103/oauth/google/callback';
process.env.INTEGRATION_ENCRYPTION_KEY = 'c'.repeat(64);
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
let exchanges = 0;
let duringRefresh;
let identityVerified = true;
mock.module('google-auth-library', { namedExports: { OAuth2Client: class {
  generateAuthUrl(opts) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ ...opts, scope: opts.scope.join(' ') })}`;
  }
  async getToken({ code, codeVerifier }) {
    exchanges++;
    assert.match(codeVerifier, /^[a-zA-Z0-9_-]{43}$/);
    if (code === 'failure') throw new Error('provider leaked access_token=do-not-print');
    return { tokens: { access_token: 'private-access', refresh_token: 'private-refresh',
      id_token: 'test-id-token',
      scope: code === 'missing-scope' ? '' : `https://www.googleapis.com/auth/${code === 'gmail' ? 'gmail.compose' : 'calendar.events.owned'}` } };
  }
  async verifyIdToken({ idToken, audience }) {
    assert.equal(idToken, 'test-id-token'); assert.equal(audience, 'test-client');
    return { getPayload: () => ({ sub: 'test-google-owner', email: 'owner@example.com', email_verified: identityVerified }) };
  }
  setCredentials(credentials) { this.credentials = credentials; }
  async getAccessToken() {
    this.credentials = { ...this.credentials, access_token: 'refreshed-private-token', expiry_date: Date.now() + 3600000 };
    if (duringRefresh) await duringRefresh();
    return { token: this.credentials.access_token };
  }
} } });
const { createApp } = await import('../create-app.js');
const { encryptIntegration, decryptIntegration, googleConfig, googleAccessToken, googleSender } = await import('../services/google-oauth.js');
const server = createApp().listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const tokens = ['a'.repeat(64), 'b'.repeat(64)], users = [];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING *', [`+1555555010${i}`])).rows[0];
  users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash('sha256').update(token).digest('hex'), user.id]);
}
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
async function api(path, method = 'GET', body, token = tokens[0]) {
  const response = await fetch(`${origin}/api/integrations/google${path}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function begin(kind = 'calendar', token = tokens[0]) {
  const start = await api('/start', 'POST', { kind }, token);
  assert.equal(start.status, 200);
  const response = await fetch(origin + new URL(start.data.url).pathname + new URL(start.data.url).search, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('location'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  return { state: url.searchParams.get('state'), cookie: response.headers.get('set-cookie').split(';')[0], start: start.data.url };
}
async function callback(flow, code = 'calendar', cookie = flow.cookie) {
  const response = await fetch(`${origin}/oauth/google/callback?state=${flow.state}&code=${code}`, {
    headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  return { status: response.status, body: await response.text(), response };
}

test('encrypted credentials are authenticated and cannot be moved to another owner', () => {
  const value = { refresh_token: 'secret-token' };
  const encrypted = encryptIntegration(value, users[0].id);
  assert.ok(!encrypted.includes('secret-token'));
  assert.deepEqual(decryptIntegration(encrypted, users[0].id), value);
  assert.throws(() => decryptIntegration(encrypted, users[1].id));
  const changed = (parseInt(encrypted.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
  assert.throws(() => decryptIntegration(`${encrypted.slice(0, -2)}${changed}`, users[0].id));
});
test('OAuth requires auth, browser cookie and owner confirmation; tickets and codes cannot replay', async () => {
  assert.equal((await api('/start', 'POST', { kind: 'calendar' }, null)).status, 401);
  assert.equal((await api('/start', 'POST', { kind: 'invalid' })).status, 400);
  const flow = await begin();
  assert.equal((await fetch(origin + new URL(flow.start).pathname + new URL(flow.start).search)).status, 400);
  assert.equal((await callback(flow, 'calendar', '')).status, 400);
  assert.equal(exchanges, 0);
  const result = await callback(flow);
  assert.equal(result.status, 200);
  assert.equal(result.response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(!result.body.includes('private-access'));
  const code = result.body.match(/\b[a-f0-9]{64}\b/)[0];
  assert.equal((await api('/')).data.connections.length, 0);
  assert.equal((await api('/confirm', 'POST', { code }, tokens[1])).status, 400);
  assert.equal((await api('/confirm', 'POST', { code })).status, 200);
  assert.equal((await api('/confirm', 'POST', { code })).status, 400);
  assert.equal((await callback(flow)).status, 400);
  const status = await api('/');
  assert.deepEqual(status.data.connections.map(c => c.kind), ['calendar']);
  assert.ok(!JSON.stringify(status.data).includes('private-'));
  assert.deepEqual((await api('/', 'GET', undefined, tokens[1])).data.connections, []);
  const stored = (await db.query('SELECT encrypted_tokens FROM google_connections WHERE user_id=$1', [users[0].id])).rows[0];
  assert.ok(!stored.encrypted_tokens.includes('private-'));
  assert.equal(decryptIntegration(stored.encrypted_tokens, users[0].id).refresh_token, 'private-refresh');
});
test('disconnect and newer starts prevent pending authorizations from reconnecting', async () => {
  const flow = await begin('gmail');
  const result = await callback(flow, 'gmail');
  const code = result.body.match(/\b[a-f0-9]{64}\b/)[0];
  await api('/gmail', 'DELETE');
  assert.equal((await api('/confirm', 'POST', { code })).status, 400);
  const older = await begin();
  await begin('gmail');
  assert.equal((await callback(older)).status, 400);
  // Disconnecting another account never alters this owner's established connection.
  await api('/calendar', 'DELETE', undefined, tokens[1]);
  assert.equal((await api('/')).data.connections[0].kind, 'calendar');
});
test('expiry, missing scope and provider errors leave no usable connection or secret in errors', async () => {
  const expired = await begin();
  await db.query("UPDATE google_oauth_requests SET expires_at=now()-interval '1 second'");
  assert.equal((await callback(expired)).status, 400);
  const missing = await begin('gmail');
  assert.equal((await callback(missing, 'missing-scope')).status, 400);
  const failure = await begin('gmail');
  const result = await callback(failure, 'failure');
  assert.equal(result.status, 400); assert.ok(!result.body.includes('do-not-print'));
  assert.equal((await api('/')).data.connections.some(c => c.kind === 'gmail'), false);
});
test('OAuth configuration rejects nonlocal HTTP, credentials and wrong callback path', () => {
  const previous = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  for (const url of ['http://example.com/oauth/google/callback', 'https://user:password@example.com/oauth/google/callback', 'https://example.com/elsewhere']) {
    process.env.GOOGLE_OAUTH_REDIRECT_URI = url; assert.throws(googleConfig);
  }
  process.env.GOOGLE_OAUTH_REDIRECT_URI = previous;
});
test('refreshed tokens remain encrypted and a disconnected grant cannot be resurrected', async () => {
  const connection = (await db.query("SELECT * FROM google_connections WHERE user_id=$1 AND kind='calendar'", [users[0].id])).rows[0];
  assert.equal(await googleAccessToken(users[0].id, 'calendar', connection.connection_id), 'refreshed-private-token');
  const updated = (await db.query("SELECT * FROM google_connections WHERE user_id=$1 AND kind='calendar'", [users[0].id])).rows[0];
  assert.ok(!updated.encrypted_tokens.includes('refreshed-private-token'));
  assert.equal(decryptIntegration(updated.encrypted_tokens, users[0].id).access_token, 'refreshed-private-token');
  duringRefresh = async () => { await db.query("DELETE FROM google_connections WHERE user_id=$1 AND kind='calendar'", [users[0].id]); };
  await assert.rejects(googleAccessToken(users[0].id, 'calendar', connection.connection_id), { code: 'google_connection_changed' });
  duringRefresh = undefined;
  assert.equal((await api('/')).data.connections.length, 0);
});
test('Gmail authorization requires a verified identity and stores its sender only in encrypted credentials', async () => {
  const unverified = await begin('gmail'); identityVerified = false;
  assert.equal((await callback(unverified, 'gmail')).status, 400);
  identityVerified = true;
  const flow = await begin('gmail'), result = await callback(flow, 'gmail');
  const code = result.body.match(/\b[a-f0-9]{64}\b/)[0];
  assert.equal((await api('/confirm', 'POST', { code })).status, 200);
  const row = (await db.query("SELECT * FROM google_connections WHERE user_id=$1 AND kind='gmail'", [users[0].id])).rows[0];
  assert.ok(!row.encrypted_tokens.includes('owner@example.com'));
  assert.equal(await googleSender(users[0].id, row.connection_id), 'owner@example.com');
  await assert.rejects(googleSender(users[1].id, row.connection_id), { code: 'gmail_reconnect_required' });
});
