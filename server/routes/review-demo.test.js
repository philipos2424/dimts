import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const DEMO = '+15555550100';
process.env.REVIEW_DEMO_PHONE = DEMO;
process.env.REVIEW_DEMO_CODE = '246810';
process.env.PUBLIC_BASE_URL = 'https://calls.example.com';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const carrier = [];
mock.module('../services/verify-phone.js', { namedExports: {
  sendPhoneCode: async phone => { carrier.push(`send:${phone}`); },
  checkPhoneCode: async phone => { carrier.push(`check:${phone}`); return true; },
} });
mock.module('../services/originate.js', { namedExports: {
  isE164: n => /^\+[1-9]\d{6,14}$/.test(n), fetchRecording: async () => {},
  originateCall: async () => { carrier.push('originate'); return 'CA_TEST'; },
} });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
test.beforeEach(async () => { carrier.length = 0; await db.query('DELETE FROM rate_limits'); });

const api = (path, { token, method = body => (body ? 'POST' : 'GET'), body, headers = {} } = {}) =>
  fetch(origin + path, { method: typeof method === 'function' ? method(body) : method, body: body && JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } })
    .then(async r => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }));
const signIn = async () => (await api('/api/auth/verify', { body: { phone: DEMO, code: '246810' } })).body.token;

test('the review number signs in with the published code and never reaches the SMS provider', async () => {
  assert.equal((await api('/api/auth/start', { body: { phone: DEMO } })).status, 202);
  assert.equal((await api('/api/auth/verify', { body: { phone: DEMO, code: '135790' } })).status, 401);
  const token = await signIn();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.deepEqual(carrier, []);
});

test('every demo sign-in restores the same sample calls, contacts and promises', async () => {
  const token = await signIn();
  const { body: { calls } } = await api('/api/calls', { token });
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.status === 'ready'));
  // A reviewer deleting a call does not break the next review.
  assert.equal((await api(`/api/calls/${calls[0].id}`, { token, method: 'DELETE', body: { confirm: 'delete-call' } })).status, 202);
  const again = await signIn();
  assert.equal((await api('/api/calls', { token: again })).body.calls.length, 6);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM contacts WHERE phone LIKE '+1512555%'")).rows[0].n, 3);
  const promises = (await api('/api/promises', { token: again })).body;
  assert.deepEqual(promises.you_owe.map(p => p.task).sort(),
    ['Send Maria an updated quote tonight', 'Send Priya a written estimate by Friday']);
});

test('a reviewer who deletes the account can sign in again to fresh sample data', async () => {
  const token = await signIn();
  assert.equal((await api('/api/me', { token, method: 'DELETE', body: { confirm: 'delete-account' } })).status, 202);
  assert.equal((await api('/api/me', { token })).status, 401);
  const fresh = await signIn();
  assert.equal((await api('/api/calls', { token: fresh })).body.calls.length, 6);
});

test('sample agreements quote real transcript lines and the price change is flagged against the earlier quote', async () => {
  const token = await signIn();
  const { body: { calls } } = await api('/api/calls', { token });
  for (const summary of calls) {
    const call = (await api(`/api/calls/${summary.id}`, { token })).body;
    const lines = call.transcript.split('\n');
    for (const agreement of (await db.query('SELECT agreements FROM calls WHERE id=$1', [call.id])).rows[0].agreements) {
      assert.equal(agreement.quote, lines[agreement.line - 1]);
    }
    assert.equal(call.recording_authorized, true);
  }
  const invoice = calls.find(call => call.summary.startsWith("Dave's invoice"));
  const [conflict] = (await api(`/api/calls/${invoice.id}`, { token })).body.conflicts;
  assert.equal(conflict.now.value, '$7.10 a square foot');
  assert.equal(conflict.before.value, '$6.50 a square foot');
});

test('calling from the review account files sample notes instead of dialing', async () => {
  const token = await signIn();
  const placed = await api('/api/calls', { token, body: { destination: '+15125550142' }, headers: { 'Idempotency-Key': 'review-demo-1' } });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.status, 'ready');
  const call = (await api(`/api/calls/${placed.body.callId}`, { token })).body;
  assert.equal(call.contact_name, 'Maria Lopez');
  assert.match(call.summary, /^Sample call from the app review account/);
  assert.deepEqual(carrier, []);
});

test('the review account cannot claim a number, verify caller ID or trigger a privacy text', async () => {
  const token = await signIn();
  for (const path of ['/api/me/number', '/api/me/caller-id/start', '/api/me/caller-id/verify']) {
    const result = await api(path, { token, body: { code: '123456' } });
    assert.equal(result.status, 403, path);
    assert.equal(result.body.error, 'review_demo');
  }
  assert.equal((await api('/api/privacy-requests/start', { body: { phone: DEMO } })).status, 202);
  assert.deepEqual(carrier, []);
});

test('without both settings the review number is an ordinary number', async () => {
  delete process.env.REVIEW_DEMO_CODE;
  try {
    await api('/api/auth/start', { body: { phone: DEMO } });
    assert.deepEqual(carrier, [`send:${DEMO}`]);
  } finally { process.env.REVIEW_DEMO_CODE = '246810'; }
});
