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
let calls = [], fail = false, text = 'Hi Abebe,\nThanks for the call. We agreed:\n• 450 birr per unit\nTalk soon.';
mock.module('../services/llm.js', { namedExports: { completeJson: async (system, input) => {
  calls.push({ system, input }); if (fail) throw new Error('model down'); return JSON.stringify({ text });
} } });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
test.beforeEach(() => { calls = []; fail = false; });

async function signedIn(phone) {
  const user = (await db.query("INSERT INTO users(phone,language) VALUES($1,'am') RETURNING id", [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  return { id: user.id, token };
}
async function seedCall(userId, status = 'ready') {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,summary,transcript,agreements,action_items)
    VALUES($1,'+1','+2',$2,'Agreed pricing.','Caller: SECRET-TRANSCRIPT-LINE 450 birr',$3,$4) RETURNING id`,
  [userId, status, JSON.stringify([{ kind: 'price', subject: 'unit price', value: '450 birr', said_by: 'Caller', quote: 'q', line: 1, start: 1 }]),
    JSON.stringify([{ task: 'Send invoice', owner: 'User' }])])).rows[0].id;
}
const recap = (id, token, query = '') => fetch(`${origin}/api/calls/${id}/recap${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('a recap is written from what was agreed, never from the transcript, and cached', async () => {
  const o = await signedIn('+15555551101');
  const id = await seedCall(o.id);
  const first = await recap(id, o.token);
  assert.equal(first.status, 200); assert.equal(first.body.text, text);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].input.includes('SECRET-TRANSCRIPT-LINE'));
  assert.match(calls[0].input, /450 birr/); assert.match(calls[0].input, /Send invoice/);
  assert.match(calls[0].system, /Amharic/);
  assert.equal((await recap(id, o.token)).body.text, text);
  assert.equal(calls.length, 1, 'second request uses the cached recap');
  await recap(id, o.token, '?refresh=1');
  assert.equal(calls.length, 2);
});

test('recaps are limited to the owner and to finished calls; model failures are explicit', async () => {
  const o = await signedIn('+15555551102'), other = await signedIn('+15555551103');
  const id = await seedCall(o.id);
  assert.equal((await recap(id, other.token)).status, 404);
  assert.equal((await recap(await seedCall(o.id, 'processing'), o.token)).status, 409);
  fail = true;
  const failed = await recap(await seedCall(o.id), o.token);
  assert.equal(failed.status, 502); assert.equal(failed.body.error, 'recap_failed');
});

test('an overlong recap is clipped', async () => {
  const o = await signedIn('+15555551104');
  text = 'x'.repeat(3000);
  assert.equal((await recap(await seedCall(o.id), o.token)).body.text.length, 1500);
});
