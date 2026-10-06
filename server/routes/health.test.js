import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
let dbDown = false;
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => { if (dbDown) throw new Error('connection refused'); return db.query(sql, p); },
  queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
let balance = '120.00';
mock.module('../lib/telnyx-rest.js', { namedExports: {
  telnyxRequest: async (method, path) => {
    assert.deepEqual([method, path], ['GET', '/balance']);
    return { balance, currency: 'USD' };
  },
  telnyxRest: () => ({}),
} });

const TOKEN = 'h'.repeat(32);
Object.assign(process.env, { HEALTH_TOKEN: TOKEN, CARRIER: 'telnyx', LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test',
  TRANSCRIBE_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'el-test' });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
test.beforeEach(async () => { dbDown = false; balance = '120.00'; await db.query('DELETE FROM calls'); await db.query('DELETE FROM users'); });

const health = (token = TOKEN) => fetch(origin + '/api/health', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  .then(async r => ({ status: r.status, body: await r.json() }));
const byName = body => Object.fromEntries(body.checks.map(c => [c.name, c]));

test('the deep health check is never public', async () => {
  assert.equal((await health(null)).status, 401);
  assert.equal((await health('wrong-token-wrong-token-wrong')).status, 401);
});

test('all green when the database answers, the balance is healthy and the AI is configured', async () => {
  const { status, body } = await health();
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(byName(body).carrier.balance, 120);
});

test('a low Telnyx balance fails the check with a plain instruction', async () => {
  balance = '4.28';
  const { status, body } = await health();
  assert.equal(status, 503);
  assert.match(byName(body).carrier.detail, /Top up/);
  assert.equal(byName(body).database.ok, true, 'one failure does not hide the others');
});

test('calls stuck in processing or failing repeatedly fail the check', async () => {
  const user = (await db.query("INSERT INTO users(phone) VALUES('+15555550001') RETURNING id")).rows[0].id;
  await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,recording_url,processing_requested_at)
    VALUES($1,'+1','+2','processing','https://r/1',now()-interval '1 hour')`, [user]);
  for (let i = 0; i < 3; i++) await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,completed_at)
    VALUES($1,'+1','+2','failed',now()-interval '1 hour')`, [user]);
  const { status, body } = await health();
  assert.equal(status, 503);
  assert.deepEqual([byName(body).calls.stuck, byName(body).calls.failed_24h], [1, 3]);
});

test('a database outage is reported, not thrown', async () => {
  dbDown = true;
  const { status, body } = await health();
  assert.equal(status, 503);
  assert.equal(byName(body).database.ok, false);
});

test('a missing AI key is reported', async () => {
  delete process.env.OPENAI_API_KEY;
  try {
    const { body } = await health();
    assert.match(byName(body).ai.detail, /OPENAI_API_KEY/);
  } finally { process.env.OPENAI_API_KEY = 'sk-test'; }
});
