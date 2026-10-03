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
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

async function signedIn(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  const contact = (await db.query("INSERT INTO contacts(user_id,phone,display_name) VALUES($1,'+15555551000','Sara') RETURNING id", [user.id])).rows[0];
  return { id: user.id, token, contact: contact.id };
}
async function call(o, items, { status = 'ready', days = 0, deleted = false } = {}) {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,action_items,created_at,deleted_at)
    VALUES($1,'+1','+15555551000',$2,$3,$4,now()-make_interval(days=>$5),CASE WHEN $6 THEN now() END) RETURNING id`,
  [o.id, o.contact, status, JSON.stringify(items), days, deleted])).rows[0].id;
}
const api = (path, token, method = 'GET', body) => fetch(origin + path, { method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('promises split into what you owe and what you are waiting on, from recent ready calls only', async () => {
  const o = await signedIn('+15555551001');
  const main = await call(o, [{ task: 'Send the proposal', owner: 'User' }, { task: 'Call back Monday', owner: 'Caller' }, { task: 'Unclear', owner: null }]);
  await call(o, [{ task: 'Old promise', owner: 'User' }], { days: 120 });
  await call(o, [{ task: 'Deleted promise', owner: 'User' }], { deleted: true });
  await call(o, [{ task: 'Still processing', owner: 'User' }], { status: 'processing' });
  const { body } = await api('/api/promises', o.token);
  assert.deepEqual(body.you_owe.map(p => [p.task, p.index, p.call_id, p.contact_name]), [['Send the proposal', 0, main, 'Sara']]);
  assert.deepEqual(body.waiting_on.map(p => p.task), ['Call back Monday']);
});

test('marking a promise done hides it; reopening brings it back; other people cannot touch it', async () => {
  const o = await signedIn('+15555551002'), other = await signedIn('+15555551003');
  const id = await call(o, [{ task: 'Send invoice', owner: 'User' }]);
  assert.equal((await api(`/api/promises/${id}/0`, other.token, 'POST', { status: 'done' })).status, 404);
  assert.equal((await api(`/api/promises/${id}/0`, o.token, 'POST', { status: 'finished' })).status, 400);
  assert.equal((await api(`/api/promises/${id}/5`, o.token, 'POST', { status: 'done' })).status, 404);
  assert.equal((await api(`/api/promises/${id}/0`, o.token, 'POST', { status: 'done' })).status, 200);
  assert.equal((await api('/api/promises', o.token)).body.you_owe.length, 0);
  await api(`/api/promises/${id}/0`, o.token, 'POST', { status: 'open' });
  assert.equal((await api('/api/promises', o.token)).body.you_owe.length, 1);
});
