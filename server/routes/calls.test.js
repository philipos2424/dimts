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
const user = (await db.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING *")).rows[0];
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
mock.module('../lib/users.js', { namedExports: {
  resolveUser: async () => user, currentMonth: () => '2026-10',
  HttpError: class extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } },
} });
let providerCalls = 0;
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
  assert.equal((await post('request-0002')).status, 409);
  assert.equal(providerCalls, 1);
});
