import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

process.env.PUBLIC_BASE_URL = 'https://calls.example.com';
process.env.TWILIO_NUMBER = '+15555550999';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const user = (await db.query("INSERT INTO users(phone,terms_version) VALUES('+15555550101','2026-10-02') RETURNING *")).rows[0];
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
mock.module('../lib/users.js', { namedExports: {
  resolveUser: async () => user, currentMonth: () => '2026-10',
  HttpError: class extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } },
} });
let providerCalls = 0;
let rejectPreflight = false;
let preflights = 0;
mock.module('../services/call-preflight.js', { namedExports: { checkCallDestination: async () => {
  preflights++;
  if (rejectPreflight) throw Object.assign(new Error('unverified destination'), { status: 403, code: 'destination_trial_number_required' });
} } });
let stops = 0;
mock.module('../services/end-call.js', { namedExports: { reconcileCall: async (_call, options) => {
  if (options?.stop) { stops++; return { ended: true }; }
  return { ended: false };
} } });
mock.module('../services/originate.js', { namedExports: {
  isE164: n => /^\+[1-9]\d{6,14}$/.test(n), fetchRecording: async () => {},
  originateCall: async () => { providerCalls++; return 'CA_TEST'; },
} });
const { callsRouter } = await import('./calls.js');
const app = express(); app.use(express.json()); app.use('/calls', callsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || err.message }));
test.after(() => db.close());
async function post(key, destination = '+15555550102') {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/calls`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify({ destination }),
    });
    return { status: response.status, data: await response.json() };
  } finally { server.close(); }
}
test('a retried HTTP request cannot originate twice; invalid requests never call Twilio', async () => {
  assert.equal((await post()).status, 400);
  assert.equal((await post('request-loop', user.phone)).status, 400);
  const first = await post('request-0001');
  const retry = await post('request-0001');
  assert.equal(first.status, 201); assert.equal(retry.status, 200);
  assert.equal(first.data.callId, retry.data.callId);
  assert.equal((await db.query('SELECT twilio_account_sid FROM calls WHERE id=$1', [first.data.callId])).rows[0].twilio_account_sid, process.env.TWILIO_ACCOUNT_SID);
  assert.equal(providerCalls, 1);
  assert.equal(preflights, 1, 'an idempotent retry skips preflight');
  assert.equal((await post('request-0002')).status, 409);
  assert.equal(providerCalls, 1);
});

test('unverified trial destinations create no call reservation or provider call', async () => {
  rejectPreflight = true;
  const before = (await db.query('SELECT count(*)::int AS count FROM calls')).rows[0].count;
  assert.equal((await post('request-unverified')).status, 403);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM calls')).rows[0].count, before);
  assert.equal(providerCalls, 1);
  rejectPreflight = false;
});

test('ending a call checks ownership before touching the provider', async () => {
  const server = app.listen(0);
  try {
    const other = (await db.query("INSERT INTO users(phone,terms_version) VALUES('+15555550103','2026-10-02') RETURNING id")).rows[0];
    const call = (await db.query("INSERT INTO calls(user_id,user_phone,destination) VALUES($1,'+15555550103','+15555550104') RETURNING id", [other.id])).rows[0];
    const url = `http://127.0.0.1:${server.address().port}/calls/`;
    assert.equal((await fetch(`${url}${call.id}/end`, { method: 'POST' })).status, 404);
    assert.equal(stops, 0);
    const own = (await db.query('SELECT id FROM calls WHERE user_id=$1 LIMIT 1', [user.id])).rows[0];
    assert.equal((await fetch(`${url}${own.id}/end`, { method: 'POST' })).status, 200);
    assert.equal(stops, 1);
  } finally { server.close(); }
});
