import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
let approved = true; const codesSent = [], notified = [];
mock.module('../services/verify-phone.js', { namedExports: {
  sendPhoneCode: async phone => { codesSent.push(phone); }, checkPhoneCode: async () => approved,
} });
mock.module('../services/notifications.js', { namedExports: {
  sendIncomingNotification: async () => {}, checkPushReceipts: async () => {}, validPushToken: () => true,
  sendPrivacyRequestNotification: async userId => { notified.push(userId); },
} });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
test.beforeEach(() => { approved = true; codesSent.length = 0; notified.length = 0; });

const post = (path, body, token) => fetch(origin + path, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
async function owner(phone, contactPhone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  const contact = (await db.query('INSERT INTO contacts(user_id,phone) VALUES($1,$2) RETURNING id', [user.id, contactPhone])).rows[0];
  return { id: user.id, token, contact: contact.id };
}
const SENT = 'Your request was sent to the businesses who recorded calls with this number. They must act within 30 days. Contact privacy@dimts.app if they do not.';

test('an invalid phone number is refused before any code is sent', async () => {
  const response = await post('/api/privacy-requests/start', { phone: '0911' });
  assert.equal(response.status, 400);
  assert.equal(codesSent.length, 0);
});

test('a verified request reaches every business holding that number, and is stored only as a hash', async () => {
  const caller = '+15555550710';
  const a = await owner('+15555550711', caller), b = await owner('+15555550712', caller);
  assert.equal((await post('/api/privacy-requests/start', { phone: caller })).status, 202);
  assert.deepEqual(codesSent, [caller]);
  const response = await post('/api/privacy-requests/verify', { phone: caller, code: '123456' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'sent', message: SENT });
  assert.deepEqual(notified.sort(), [a.id, b.id].sort());
  const stored = (await db.query('SELECT phone_hash FROM privacy_requests')).rows;
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].phone_hash, caller);
  assert.ok(!JSON.stringify(stored).includes('5555550710'));
  const listed = await (await fetch(origin + '/api/me/privacy-requests', { headers: { Authorization: `Bearer ${a.token}` } })).json();
  assert.equal(listed.requests.length, 1);
  assert.equal(listed.requests[0].contact_id, a.contact);
  const due = new Date(listed.requests[0].due_at) - new Date(listed.requests[0].created_at);
  assert.equal(Math.round(due / 86_400_000), 30);
  const deleted = await fetch(origin + `/api/contacts/${a.contact}`, { method: 'DELETE',
    headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'delete-contact' }) });
  assert.equal(deleted.status, 200);
  const after = await (await fetch(origin + '/api/me/privacy-requests', { headers: { Authorization: `Bearer ${a.token}` } })).json();
  assert.equal(after.requests.length, 0, 'deleting the contact resolves the request');
});

test('a request for a number nobody holds looks identical and notifies no one', async () => {
  const response = await post('/api/privacy-requests/verify', { phone: '+15555550799', code: '123456' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'sent', message: SENT });
  assert.equal(notified.length, 0);
});

test('a wrong code is refused and creates nothing', async () => {
  approved = false;
  const before = (await db.query('SELECT count(*)::int n FROM privacy_requests')).rows[0].n;
  assert.equal((await post('/api/privacy-requests/verify', { phone: '+15555550720', code: '000000' })).status, 401);
  assert.equal((await db.query('SELECT count(*)::int n FROM privacy_requests')).rows[0].n, before);
});

test('codes for one number are limited to five an hour', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/privacy-requests/start', { phone: '+15555550730' })).status, 202);
  assert.equal((await post('/api/privacy-requests/start', { phone: '+15555550730' })).status, 429);
});
