import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
mock.module('../services/verify-phone.js', { namedExports: {
  sendPhoneCode: async () => {}, checkPhoneCode: async () => true,
} });
const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://exp.host/')) { pushes.push(JSON.parse(init.body)); return new Response('{"data":[]}'); }
  return realFetch(url, init);
};
const { createApp } = await import('../create-app.js');
const { drainDeferredWork } = await import('../lib/defer.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

const api = (path, token, { method = 'GET', body, agent } = {}) => realFetch(origin + path, { method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(agent ? { 'User-Agent': agent } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const signIn = async (phone, extra = {}) => (await api('/api/auth/verify', null, { method: 'POST', body: { phone, code: '123456', ...extra.body }, agent: extra.agent })).body.token;

test('every sign-in is listed by device, and the current one is marked', async () => {
  const phone = '+15555551001';
  const first = await signIn(phone, { body: { device: 'Philipos’s iPhone\u0000' } });
  const second = await signIn(phone, { agent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/140.0 Safari/537.36' });
  const { body } = await api('/api/me/sessions', second);
  assert.deepEqual(body.sessions.map(s => s.device_name).sort(), ['Chrome on Windows', 'Philipos’s iPhone']);
  assert.equal(body.sessions.find(s => s.current).device_name, 'Chrome on Windows');
  assert.ok(body.sessions.every(s => s.id && s.created_at && !('token_hash' in s)));
  assert.equal((await api('/api/me/sessions', first)).body.sessions.find(s => s.current).device_name, 'Philipos’s iPhone');
});

test('a new sign-in warns the owner\'s other devices, not the new one', async () => {
  const phone = '+15555551002';
  const phoneToken = await signIn(phone, { body: { device: 'Pixel 8' } });
  const me = (await db.query('SELECT id FROM users WHERE phone=$1', [phone])).rows[0];
  const hash = (await db.query('SELECT token_hash FROM sessions WHERE user_id=$1', [me.id])).rows[0].token_hash;
  await db.query(`INSERT INTO notification_devices(user_id,session_hash,push_token) VALUES($1,$2,'ExponentPushToken[aaaaaaaaaaaaaa]')`, [me.id, hash]);
  pushes.length = 0;
  await signIn(phone, { body: { device: 'Unknown laptop' } });
  await drainDeferredWork();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0][0].to, 'ExponentPushToken[aaaaaaaaaaaaaa]');
  assert.match(pushes[0][0].body, /Unknown laptop signed in/);
  assert.equal(pushes[0][0].data.type, 'new-sign-in');
  assert.ok(phoneToken);
});

test('the owner can end one other session, or every other session, and nobody else\'s', async () => {
  const phone = '+15555551003';
  const mine = await signIn(phone, { body: { device: 'Mine' } });
  await signIn(phone, { body: { device: 'Thief' } }); await signIn(phone, { body: { device: 'Old tablet' } });
  const stranger = await signIn('+15555551004', { body: { device: 'Stranger' } });
  const sessions = (await api('/api/me/sessions', mine)).body.sessions;
  const thief = sessions.find(s => s.device_name === 'Thief');
  const strangers = (await api('/api/me/sessions', stranger)).body.sessions[0];

  assert.equal((await api(`/api/me/sessions/${strangers.id}`, mine, { method: 'DELETE' })).status, 404);
  assert.equal((await api('/api/me/sessions/not-a-uuid', mine, { method: 'DELETE' })).status, 404);
  const ended = await api(`/api/me/sessions/${thief.id}`, mine, { method: 'DELETE' });
  assert.deepEqual(ended.body, { status: 'signed_out', current: false });
  assert.deepEqual((await api('/api/me/sessions', mine)).body.sessions.map(s => s.device_name).sort(), ['Mine', 'Old tablet']);

  assert.equal((await api('/api/me/sessions/revoke', mine, { method: 'POST' })).body.ended, 1);
  assert.deepEqual((await api('/api/me/sessions', mine)).body.sessions.map(s => s.device_name), ['Mine']);
  assert.equal((await api('/api/me/sessions', stranger)).status, 200, 'other accounts are untouched');

  assert.equal((await api('/api/me/sessions/revoke?all=1', mine, { method: 'POST' })).body.ended, 1);
  assert.equal((await api('/api/me/sessions', mine)).status, 401);
  const actions = (await db.query(`SELECT action FROM audit_events a JOIN users u ON u.id=a.user_id WHERE u.phone=$1 ORDER BY a.id`, [phone])).rows.map(r => r.action);
  assert.deepEqual(actions.filter(a => a.startsWith('session')), ['session_revoked', 'sessions_revoked_others', 'sessions_revoked_all']);
});
