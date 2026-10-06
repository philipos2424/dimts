import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
process.env.DATA_ENCRYPTION_KEYS = `t1:${randomBytes(32).toString('base64')}`;
const { openRows, sealJson, sealText } = await import('../lib/field-crypto.js');
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
// The same opening the real pool.js applies to every result.
mock.module('../db/pool.js', { namedExports: {
  query: async (sql, p) => openRows(await db.query(sql, p)),
  queryOne: async (sql, p) => openRows(await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(tx => work({ query: async (sql, p) => openRows(await tx.query(sql, p)) })),
  getPool: () => ({}),
} });
let reply;
mock.module('../services/llm.js', { namedExports: { completeJson: async () => JSON.stringify(reply) } });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

async function signedIn(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  return { id: user.id, token };
}
const api = (path, token, { method = 'GET', body } = {}) => fetch(origin + path, { method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));

async function sealedCall(userId, transcript, summary) {
  const id = randomUUID(), seal = (column, value) => sealText(value, { userId, rowId: id, field: `calls:${column}` });
  await db.query(`INSERT INTO calls(id,user_id,user_phone,destination,status,direction,transcript,transcript_data,summary)
    VALUES($1,$2,'+1','+15555552999','ready','outbound',$3,$4,$5)`,
  [id, userId, seal('transcript', transcript), sealJson({ words: [] }, { userId, rowId: id, field: 'calls:transcript_data' }), seal('summary', summary)]);
  return id;
}

test('the database holds only ciphertext, and the owner reads the call as normal', async () => {
  const o = await signedIn('+15555552001');
  const id = await sealedCall(o.id, 'User: Can you deliver 40 bags of cement?\nCaller: Yes, by Friday.', 'Cement delivery agreed for Friday.');
  const raw = (await db.query('SELECT transcript, summary, transcript_data::text AS data FROM calls WHERE id=$1', [id])).rows[0];
  for (const value of Object.values(raw)) assert.ok(!/cement|Friday|words/i.test(value), 'no plaintext at rest');
  const { status, body } = await api(`/api/calls/${id}`, o.token);
  assert.equal(status, 200);
  assert.match(body.transcript, /40 bags of cement/);
  assert.equal(body.summary, 'Cement delivery agreed for Friday.');
});

test('Ask still finds the right call by its words although the database cannot read them', async () => {
  const o = await signedIn('+15555552002');
  await sealedCall(o.id, 'User: About the roof repair.\nCaller: I will send the quote.', 'Roof quote.');
  const target = await sealedCall(o.id, 'User: How much for the generator?\nCaller: The generator is 900 dollars.', 'Generator price.');
  reply = { type: 'answer', answer: 'It is 900 dollars.', citations: [{ call: 'C1', line: 2 }] };
  const { body } = await api('/api/ask', o.token, { method: 'POST', body: { question: 'what was the generator price?' } });
  assert.equal(body.grounded, true);
  assert.equal(body.citations[0].call_id, target);
  assert.match(body.citations[0].quote, /900 dollars/);
});

test('contact notes and recaps are encrypted when saved', async () => {
  const o = await signedIn('+15555552003');
  const contact = (await db.query(`INSERT INTO contacts(user_id,phone,display_name) VALUES($1,'+15555552998','Abebe') RETURNING id`, [o.id])).rows[0];
  const saved = await api(`/api/contacts/${contact.id}`, o.token, { method: 'PATCH', body: { display_name: 'Abebe', notes: 'Prefers calls after 6pm' } });
  assert.equal(saved.body.notes, 'Prefers calls after 6pm');
  assert.ok(!(await db.query('SELECT notes FROM contacts WHERE id=$1', [contact.id])).rows[0].notes.includes('6pm'));

  const id = await sealedCall(o.id, 'User: hi\nCaller: hello', 'A greeting.');
  reply = { text: 'Thanks for the call today.' };
  assert.equal((await api(`/api/calls/${id}/recap`, o.token, { method: 'POST' })).body.text, 'Thanks for the call today.');
  assert.ok(!(await db.query('SELECT recap FROM calls WHERE id=$1', [id])).rows[0].recap.includes('Thanks'));
  assert.equal((await api(`/api/calls/${id}/recap`, o.token, { method: 'POST' })).body.text, 'Thanks for the call today.', 'served back from storage');
});

test('another user cannot read a call even with the same server keys', async () => {
  const owner = await signedIn('+15555552004'), other = await signedIn('+15555552005');
  const id = await sealedCall(owner.id, 'User: private', 'Private.');
  assert.equal((await api(`/api/calls/${id}`, other.token)).status, 404);
  // Copying the ciphertext into the other user's row does not make it readable.
  const stolen = (await db.query('SELECT transcript FROM calls WHERE id=$1', [id])).rows[0].transcript;
  const copy = randomUUID();
  await db.query(`INSERT INTO calls(id,user_id,user_phone,destination,status,direction,transcript) VALUES($1,$2,'+1','+2','ready','outbound',$3)`,
    [copy, other.id, stolen.replace(id, copy).replace(owner.id, other.id)]);
  assert.equal((await api(`/api/calls/${copy}`, other.token)).status, 500);
});
