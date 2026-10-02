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
  return { id: user.id, token };
}
const get = (path, token) => fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } }).then(async r => ({ status: r.status, body: await r.json() }));

test('a person page shows the contact, their calls newest first and open promises with them', async () => {
  const o = await signedIn('+15555551401'), other = await signedIn('+15555551402');
  const contact = (await db.query("INSERT INTO contacts(user_id,phone,display_name,company) VALUES($1,'+15555551499','Abebe','Amax') RETURNING id", [o.id])).rows[0].id;
  const older = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,summary,created_at,action_items,agreements)
    VALUES($1,'+1','+15555551499',$2,'ready','First',now()-interval '2 days','[{"task":"Send price list","owner":"User"}]','[{"subject":"price","value":"500 birr"}]') RETURNING id`, [o.id, contact])).rows[0].id;
  const newer = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,summary)
    VALUES($1,'+1','+15555551499',$2,'ready','Second') RETURNING id`, [o.id, contact])).rows[0].id;
  await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,summary,deleted_at)
    VALUES($1,'+1','+15555551499',$2,'deleted','Gone',now())`, [o.id, contact]);
  const { status, body } = await get(`/api/contacts/${contact}`, o.token);
  assert.equal(status, 200);
  assert.equal(body.contact.display_name, 'Abebe'); assert.equal(body.contact.company, 'Amax');
  assert.deepEqual(body.calls.map(c => c.id), [newer, older]);
  assert.equal(body.calls[1].agreements[0].value, '500 birr');
  assert.deepEqual(body.promises.you_owe.map(p => p.task), ['Send price list']);
  assert.deepEqual(body.promises.waiting_on, []);
  assert.equal((await get(`/api/contacts/${contact}`, other.token)).status, 404);
  assert.equal((await get('/api/contacts/not-a-uuid', o.token)).status, 404);
});
