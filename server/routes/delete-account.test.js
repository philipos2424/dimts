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
const queued = [];
mock.module('../services/process-deletion.js', { namedExports: { processDeletion: async id => { queued.push(id); return { status: 'confirmed' }; } } });
mock.module('../services/verify-phone.js', { namedExports: { sendPhoneCode: async () => {}, checkPhoneCode: async () => true } });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
test.beforeEach(() => { queued.length = 0; });

let n = 0;
async function account() {
  n += 1;
  const phone = `+1555555${String(6000 + n)}`, agent = `+1555556${String(6000 + n)}`;
  await db.query("INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES($1,$2,'https://x/twiml/incoming')", [agent, 'PN' + randomBytes(16).toString('hex')]);
  const user = (await db.query("INSERT INTO users(phone,agent_number,terms_version) VALUES($1,$2,'2026-10-02') RETURNING id", [phone, agent])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  const contact = (await db.query("INSERT INTO contacts(user_id,phone,display_name) VALUES($1,'+15555550999','Sara') RETURNING id", [user.id])).rows[0];
  const other = (await db.query("INSERT INTO contacts(user_id,phone,display_name) VALUES($1,'+15555550998','Dawit') RETURNING id", [user.id])).rows[0];
  const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,duration_sec,recording_url,recording_sid,transcript)
    VALUES($1,$2,'+15555550999',$3,'ready',60,'https://api.twilio.com/r','RE${'c'.repeat(32)}','Private') RETURNING id`, [user.id, phone, contact.id])).rows[0];
  const otherCall = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,duration_sec,transcript)
    VALUES($1,$2,'+15555550998',$3,'ready',60,'Keep me') RETURNING id`, [user.id, phone, other.id])).rows[0];
  await db.query("INSERT INTO google_connections(user_id,kind,encrypted_tokens) VALUES($1,'gmail','SECRET')", [user.id]);
  return { id: user.id, phone, agent, token, contact: contact.id, other: other.id, call: call.id, otherCall: otherCall.id };
}
const send = (path, token, method, body) => fetch(origin + path, { method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const count = async (sql, p) => (await db.query(sql, p)).rows[0].n;

test('account deletion needs an explicit confirmation', async () => {
  const a = await account();
  const response = await send('/api/me', a.token, 'DELETE', {});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'deletion_confirmation_required');
});

test('nothing is deleted while a call is active or still being processed', async () => {
  for (const status of ['in-progress', 'processing']) {
    const a = await account();
    await db.query('UPDATE calls SET status=$2 WHERE id=$1', [a.call, status]);
    const response = await send('/api/me', a.token, 'DELETE', { confirm: 'delete-account' });
    assert.equal(response.status, 409, status);
    assert.equal(await count('SELECT count(*)::int n FROM contacts WHERE user_id=$1', [a.id]), 2);
    assert.equal(await count('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [a.id]), 1);
    assert.equal(await count('SELECT count(*)::int n FROM calls WHERE user_id=$1 AND deleted_at IS NOT NULL', [a.id]), 0);
  }
});

test('deleting an account removes everything personal, frees the number and signs out every session', async () => {
  const a = await account();
  const response = await send('/api/me', a.token, 'DELETE', { confirm: 'delete-account' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, 1);
  assert.equal(await count('SELECT count(*)::int n FROM calls WHERE user_id=$1 AND deleted_at IS NULL', [a.id]), 0);
  assert.equal(await count('SELECT count(*)::int n FROM calls WHERE user_id=$1 AND transcript IS NOT NULL', [a.id]), 0);
  for (const table of ['contacts', 'google_connections', 'sessions', 'notification_devices'])
    assert.equal(await count(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`, [a.id]), 0, table);
  const user = (await db.query('SELECT phone,agent_number,deleted_at,terms_version FROM users WHERE id=$1', [a.id])).rows[0];
  assert.equal(user.phone, `deleted:${a.id}`);
  assert.equal(user.agent_number, null);
  assert.ok(user.deleted_at);
  assert.equal(user.terms_version, null);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(queued, [a.call]);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE user_id=$1 AND action='account_deleted'", [a.id]), 1);
  assert.equal((await send('/api/me', a.token, 'GET')).status, 401);
  const pool = (await db.query('SELECT enabled FROM agent_number_pool WHERE phone=$1', [a.agent])).rows[0];
  assert.equal(pool.enabled, true);
  const relogin = await fetch(origin + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: a.phone, code: '123456' }) });
  const fresh = await relogin.json();
  assert.equal(relogin.status, 200);
  const freshId = (await db.query('SELECT id FROM users WHERE phone=$1', [a.phone])).rows[0].id;
  assert.notEqual(freshId, a.id);
  assert.equal(fresh.terms_required, true);
});

test("deleting a contact deletes only that person's calls, and only for the owner", async () => {
  const a = await account(), b = await account();
  assert.equal((await send(`/api/contacts/${a.contact}`, a.token, 'DELETE', {})).status, 400);
  assert.equal((await send(`/api/contacts/${a.contact}`, b.token, 'DELETE', { confirm: 'delete-contact' })).status, 404);
  const response = await send(`/api/contacts/${a.contact}`, a.token, 'DELETE', { confirm: 'delete-contact' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted_calls, 1);
  assert.equal(await count('SELECT count(*)::int n FROM contacts WHERE id=$1', [a.contact]), 0);
  assert.ok((await db.query('SELECT deleted_at FROM calls WHERE id=$1', [a.call])).rows[0].deleted_at);
  assert.equal((await db.query('SELECT transcript FROM calls WHERE id=$1', [a.otherCall])).rows[0].transcript, 'Keep me');
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE user_id=$1 AND action='contact_deleted'", [a.id]), 1);
});

test('a call stuck in processing after its lease expired does not block account deletion', async () => {
  const a = await account();
  await db.query("UPDATE calls SET status='processing',processing_until=now()-interval '5 minutes' WHERE id=$1", [a.call]);
  const response = await send('/api/me', a.token, 'DELETE', { confirm: 'delete-account' });
  assert.equal(response.status, 202);
});
