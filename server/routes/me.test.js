import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { TERMS_VERSION } from '../lib/terms.js';
const hashToken = token => createHash('sha256').update(token).digest('hex');
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

async function signedIn(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(token), user.id]);
  return { id: user.id, token };
}
async function api(path, token, { method = 'GET', body } = {}) {
  const response = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('a new account must accept the current terms, and acceptance is recorded and audited', async () => {
  const owner = await signedIn('+15555550201');
  assert.equal((await api('/api/me', owner.token)).body.terms_required, true);
  const stale = await api('/api/me/terms', owner.token, { method: 'POST', body: { version: '2020-01-01' } });
  assert.equal(stale.status, 400); assert.equal(stale.body.error, 'terms_version_mismatch');
  const accepted = await api('/api/me/terms', owner.token, { method: 'POST', body: { version: TERMS_VERSION } });
  assert.equal(accepted.status, 200); assert.ok(accepted.body.accepted_at);
  assert.equal((await api('/api/me', owner.token)).body.terms_required, false);
  const row = (await db.query('SELECT terms_version,terms_accepted_at FROM users WHERE id=$1', [owner.id])).rows[0];
  assert.equal(row.terms_version, TERMS_VERSION); assert.ok(row.terms_accepted_at);
  const audited = (await db.query("SELECT count(*)::int n FROM audit_events WHERE user_id=$1 AND action='terms_accepted'", [owner.id])).rows[0].n;
  assert.equal(audited, 1);
});

test('activity lists only the signed-in user\'s events, newest first', async () => {
  const a = await signedIn('+15555550202'), b = await signedIn('+15555550203');
  await db.query(`INSERT INTO audit_events(user_id,action,created_at) VALUES
    ($1,'signed_in',now()-interval '2 minutes'),($1,'call_deleted',now()-interval '1 minute'),($2,'signed_in',now())`, [a.id, b.id]);
  const { body } = await api('/api/me/activity', a.token);
  assert.deepEqual(body.events.map(e => e.action), ['call_deleted', 'signed_in']);
  assert.ok(!('user_id' in body.events[0]) && !('ip_hash' in body.events[0]));
});

test('the summary language is validated, saved and returned', async () => {
  const owner = await signedIn('+15555550209');
  assert.equal((await api('/api/me', owner.token)).body.language, 'en');
  assert.equal((await api('/api/me', owner.token, { method: 'PATCH', body: { language: 'fr' } })).status, 400);
  const saved = await api('/api/me', owner.token, { method: 'PATCH', body: { language: 'am' } });
  assert.equal(saved.status, 200); assert.equal(saved.body.language, 'am');
  assert.equal((await api('/api/me', owner.token)).body.language, 'am');
});

test('app_calls_findable is off by default, returned by GET and changed only by a boolean, with an audit event', async () => {
  const owner = await signedIn('+15555550230');
  assert.equal((await api('/api/me', owner.token)).body.app_calls_findable, false);
  for (const bad of ['true', 1, null]) {
    const refused = await api('/api/me', owner.token, { method: 'PATCH', body: { app_calls_findable: bad } });
    assert.equal(refused.status, 400); assert.equal(refused.body.error, 'invalid_app_calls_findable');
  }
  const on = await api('/api/me', owner.token, { method: 'PATCH', body: { app_calls_findable: true } });
  assert.equal(on.status, 200); assert.equal(on.body.app_calls_findable, true);
  assert.equal((await api('/api/me', owner.token)).body.app_calls_findable, true);
  const off = await api('/api/me', owner.token, { method: 'PATCH', body: { app_calls_findable: false, language: 'am' } });
  assert.equal(off.body.app_calls_findable, false); assert.equal(off.body.language, 'am');
  const events = (await db.query("SELECT target_id FROM audit_events WHERE user_id=$1 AND action='app_calls_findable_changed' ORDER BY id", [owner.id])).rows;
  assert.deepEqual(events.map(e => e.target_id), ['on', 'off']);
});
