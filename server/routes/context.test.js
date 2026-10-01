import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
} });
const { createApp } = await import('../create-app.js');
const app = createApp();
const tokens = ['a'.repeat(64), 'b'.repeat(64)];
const users = [];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING *', [`+1555555010${i + 1}`])).rows[0];
  users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash('sha256').update(token).digest('hex'), user.id]);
}
const phone = '+15555550103';
await db.query("INSERT INTO contacts(user_id,phone,display_name,notes) VALUES($1,$2,'Phili','Amax lead')", [users[0].id, phone]);
async function seed(owner, status, summary, time, direction = 'outbound') {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,summary,created_at,direction,action_items,next_moves)
    VALUES($1,$2,$3,$4,$5,$6,$7,'[{"task":"Send pricing","owner":"Caller"}]','["Review pricing"]') RETURNING *`,
    [owner.id, owner.phone, phone, status, summary, time, direction])).rows[0];
}
const previous = await seed(users[0], 'ready', 'Pricing was discussed.', '2026-09-30T10:00:00Z');
const current = await seed(users[0], 'ready', 'Current call must not brief itself.', '2026-10-01T10:00:00Z');
await seed(users[0], 'ready', 'A later call must not enter an earlier briefing.', '2026-10-02T10:00:00Z');
await seed(users[0], 'failed', 'Failed processing is not trusted memory.', '2026-09-30T11:00:00Z');
await seed(users[1], 'ready', 'Other account secret.', '2026-09-30T12:00:00Z');
test.after(() => db.close());
async function request(path, token = tokens[0]) {
  const server = app.listen(0);
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: result.status, data: await result.json() };
  } finally { server.close(); }
}
test('briefing includes only prior ready calls belonging to the current owner', async () => {
  const result = await request(`/calls/${current.id}/context`);
  assert.equal(result.status, 200);
  assert.equal(result.data.contact.display_name, 'Phili');
  assert.deepEqual(result.data.previous_calls.map(c => c.id), [previous.id]);
  assert.equal(result.data.previous_calls[0].action_items[0].owner, 'Caller');
  assert.equal((await request(`/calls/${current.id}/context`, tokens[1])).status, 404);
  assert.equal((await request(`/calls/${current.id}/context`, null)).status, 401);
});
test('phone lookup is exact and private, with empty memory for a new contact', async () => {
  assert.equal((await request('/contacts/context?phone=invalid')).status, 400);
  const empty = (await request('/contacts/context?phone=%2B15555550104')).data;
  assert.equal(empty.contact, null); assert.deepEqual(empty.previous_calls, []);
  const other = (await request(`/contacts/context?phone=${encodeURIComponent(phone)}`, tokens[1])).data;
  assert.equal(other.contact, null);
  assert.equal(other.previous_calls.length, 1);
  assert.equal(other.previous_calls[0].summary, 'Other account secret.');
});
test('active incoming lookup omits completed, stale, outgoing and other owner calls', async () => {
  await seed(users[0], 'ringing', null, new Date().toISOString(), 'outbound');
  await seed(users[0], 'ringing', null, new Date(Date.now() - 3600000).toISOString(), 'inbound');
  await seed(users[0], 'completed', null, new Date().toISOString(), 'inbound');
  assert.equal((await request('/calls/incoming/active')).data.call, null);
  const incoming = await seed(users[0], 'ringing', null, new Date().toISOString(), 'inbound');
  assert.equal((await request('/calls/incoming/active')).data.call.id, incoming.id);
  assert.equal((await request('/calls/incoming/active', tokens[1])).data.call, null);
  await db.query("UPDATE calls SET status='processing',duration_sec=60 WHERE id=$1", [incoming.id]);
  assert.equal((await request('/calls/incoming/active')).data.call, null);
});
