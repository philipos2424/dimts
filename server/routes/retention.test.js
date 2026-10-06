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
process.env.CRON_SECRET = 'retention-cron-secret-123';
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

async function signedIn(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash('sha256').update(token).digest('hex'), user.id]);
  return { id: user.id, token };
}
const api = (path, token, { method = 'GET', body } = {}) => fetch(origin + path, { method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));
const call = async (userId, months) => (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,direction,duration_sec,transcript,summary,created_at)
  VALUES($1,'+1','+2','ready','outbound',60,'Caller: hello.','A call.',now()-make_interval(months=>$2)) RETURNING id`, [userId, months])).rows[0].id;

test('the owner chooses how long calls are kept; only allowed periods are accepted and the change is audited', async () => {
  const o = await signedIn('+15555550901');
  assert.equal((await api('/api/me', o.token)).body.retention_months, null);
  assert.equal((await api('/api/me', o.token, { method: 'PATCH', body: { retention_months: 5 } })).status, 400);
  const saved = await api('/api/me', o.token, { method: 'PATCH', body: { retention_months: 6 } });
  assert.equal(saved.status, 200); assert.equal(saved.body.retention_months, 6); assert.equal(saved.body.language, 'en');
  assert.equal((await api('/api/me', o.token)).body.retention_months, 6);
  assert.equal((await api('/api/me', o.token, { method: 'PATCH', body: { retention_months: null } })).body.retention_months, null);
  const n = (await db.query("SELECT count(*)::int n FROM audit_events WHERE user_id=$1 AND action='retention_changed'", [o.id])).rows[0].n;
  assert.equal(n, 2);
});

test('the daily sweep deletes only calls past their owner\'s period, and only with the cron secret', async () => {
  const keeps = await signedIn('+15555550902'), limited = await signedIn('+15555550903');
  await db.query('UPDATE users SET retention_months=3 WHERE id=$1', [limited.id]);
  const old = await call(limited.id, 4), recent = await call(limited.id, 1), forever = await call(keeps.id, 30);
  assert.equal((await fetch(origin + '/api/cron/retention')).status, 401);
  const result = await fetch(origin + '/api/cron/retention', { headers: { Authorization: 'Bearer retention-cron-secret-123' } }).then(r => r.json());
  assert.deepEqual(result, { deleted: 1, skipped: 0, numbers: { released: 0 }, costs: { skipped: 'telnyx_not_configured' } });
  const rows = Object.fromEntries((await db.query('SELECT id, deleted_at, transcript FROM calls WHERE id = ANY($1)', [[old, recent, forever]])).rows.map(r => [r.id, r]));
  assert.ok(rows[old].deleted_at); assert.equal(rows[old].transcript, null);
  assert.equal(rows[recent].deleted_at, null); assert.equal(rows[forever].deleted_at, null);
  const audited = (await db.query("SELECT target_id FROM audit_events WHERE user_id=$1 AND action='call_auto_deleted'", [limited.id])).rows;
  assert.deepEqual(audited.map(r => r.target_id), [old]);
});
