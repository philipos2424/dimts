import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let approved = true;
const writes = [];
const sent = [];
const sessions = new Map();
const counts = new Map();
const users = new Map();
mock.module('../db/pool.js', { namedExports: {
  queryOne: async (sql, params) => {
    if (sql.includes('auth_rate_limits')) {
      const count = (counts.get(params[0]) ?? 0) + 1;
      counts.set(params[0], count);
      return { attempts: count };
    }
    if (sql.includes('INSERT INTO users')) {
      const user = { id: `owner-${params[0]}`, phone: params[0], tier: 'free' };
      users.set(user.id, user);
      return user;
    }
    if (sql.includes('FROM sessions')) return users.get(sessions.get(params[0]));
    if (sql.includes('FROM users WHERE id')) return users.get(params[0]);
  },
  query: async (sql, params) => {
    writes.push({ sql, params });
    if (sql.includes('INSERT INTO sessions')) sessions.set(params[0], params[1]);
    if (sql.includes('DELETE FROM sessions')) sessions.delete(params[0]);
    return { rows: [] };
  },
  getPool: () => ({}),
} });
mock.module('../services/verify-phone.js', { namedExports: {
  sendPhoneCode: async (phone) => sent.push(phone),
  checkPhoneCode: async () => approved,
} });
const { createApp } = await import('../create-app.js');
const app = createApp();
async function request(path, body, token, headers = {}) {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally { server.close(); }
}
test.beforeEach(() => {
  approved = true; writes.length = 0; sent.length = 0; sessions.clear(); counts.clear(); users.clear();
});
test('rejects the old spoofable phone header', async () => {
  const response = await request('/api/me', undefined, null, { 'x-user-phone': '+14754053943' });
  assert.equal(response.status, 401);
});
test('invalid verification never creates an account or a session', async () => {
  approved = false;
  const result = await request('/api/auth/verify', { phone: '+14754053943', code: '123456' });
  assert.equal(result.status, 401);
  assert.equal(users.size, 0);
  assert.equal(sessions.size, 0);
});
test('verified login stores only a token hash and logout revokes access', async () => {
  const login = await request('/api/auth/verify', { phone: '+14754053943', code: '123456' });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(sessions.has(token), false);
  assert.equal(sessions.has(createHash('sha256').update(token).digest('hex')), true);
  assert.equal((await request('/api/me', undefined, token)).body.phone, '+14754053943');
  assert.equal((await request('/api/auth/logout', {}, token)).status, 200);
  assert.equal((await request('/api/me', undefined, token)).status, 401);
});
test('each verified session resolves its own account', async () => {
  const first = await request('/api/auth/verify', { phone: '+14754053943', code: '123456' });
  const second = await request('/api/auth/verify', { phone: '+15551234567', code: '123456' });
  const profile = await request('/api/me', undefined, first.body.token, { 'x-user-phone': second.body.phone });
  assert.equal(profile.body.phone, first.body.phone);
});
test('bounds SMS attempts before calling the paid provider again', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await request('/api/auth/start', { phone: '+14754053943' })).status, 202);
  assert.equal((await request('/api/auth/start', { phone: '+14754053943' })).status, 429);
  assert.equal(sent.length, 5);
});
test('rejects malformed phone numbers before sending SMS', async () => {
  assert.equal((await request('/api/auth/start', { phone: '475' })).status, 400);
  assert.equal(sent.length, 0);
});
test('sign-in reports that terms are required and audits sign-in and sign-out without the raw IP', async () => {
  const login = await request('/api/auth/verify', { phone: '+14754053943', code: '123456' });
  assert.equal(login.body.terms_required, true);
  const signedIn = writes.find(w => w.sql.includes('audit_events') && w.params.includes('signed_in'));
  assert.ok(signedIn, 'signed_in audited');
  assert.equal(signedIn.params[0], 'owner-+14754053943');
  assert.ok(!signedIn.params.some(p => typeof p === 'string' && p.includes('127.0.0.1')), 'IP is hashed');
  await request('/api/auth/logout', {}, login.body.token);
  assert.ok(writes.some(w => w.sql.includes('audit_events') && w.params.includes('signed_out')));
});
