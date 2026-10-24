import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
process.env.DATA_ENCRYPTION_KEYS = `t1:${randomBytes(32).toString('base64')}`;
const { openRows, sealJson } = await import('../lib/field-crypto.js');
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
// The same opening the real pool.js applies to every result.
mock.module('../db/pool.js', { namedExports: {
  query: async (sql, p) => openRows(await db.query(sql, p)),
  queryOne: async (sql, p) => openRows(await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(tx => work({ query: async (sql, p) => openRows(await tx.query(sql, p)) })),
  getPool: () => ({}),
} });
let llmReply = { conflicts: [] };
mock.module('../services/llm.js', { namedExports: { completeJson: async () => JSON.stringify(llmReply) } });
const { createApp } = await import('../create-app.js');
const { checkConsistency } = await import('../services/consistency.js');
const { encryptExisting } = await import('../services/encrypt-existing.js');
const { buildExport } = await import('../services/export-user.js');
const { compliance } = await import('../services/admin-metrics.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

const FACTS = ['next_moves', 'action_items', 'key_points', 'agreements', 'conflicts'];
// Anything a database dump must not reveal.
const SECRET = /cement|birr|proposal|Friday|quote|changed/i;

async function signedIn(phone, timezone = 'UTC') {
  const user = (await db.query('INSERT INTO users(phone,timezone) VALUES($1,$2) RETURNING id', [phone, timezone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  const contact = (await db.query("INSERT INTO contacts(user_id,phone,display_name) VALUES($1,'+15555553000','Sara') RETURNING id", [user.id])).rows[0];
  return { id: user.id, token, contact: contact.id };
}
const api = (path, token, { method = 'GET', body } = {}) => fetch(origin + path, { method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));

/** A ready call whose conversation facts are stored the way the server stores them: sealed. */
async function call(o, facts, { days = 0, sealed = true } = {}) {
  const id = randomUUID();
  const bind = column => facts[column] === undefined ? null
    : sealed ? sealJson(facts[column], { userId: o.id, rowId: id, field: `calls:${column}` }) : JSON.stringify(facts[column]);
  await db.query(`INSERT INTO calls(id,user_id,user_phone,destination,contact_id,status,direction,duration_sec,created_at,
      next_moves,action_items,key_points,agreements,conflicts)
    VALUES($1,$2,'+1','+15555553000',$3,'ready','outbound',60,now()-make_interval(days=>$4),$5,$6,$7,$8,$9)`,
  [id, o.id, o.contact, days, ...FACTS.map(bind)]);
  return id;
}
const rawColumn = async (id, column) => (await db.query(`SELECT ${column}::text AS v FROM calls WHERE id=$1`, [id])).rows[0].v;
const priceAgreement = { kind: 'price', subject: 'Cement', value: '40,000 birr', said_by: 'Caller',
  quote: 'Caller: The cement is 40,000 birr', line: 2, start: 3.5 };

test('the briefing still lists agreed prices, contradictions and next steps when they are sealed at rest', async () => {
  const o = await signedIn('+15555553001');
  const id = await call(o, {
    agreements: [priceAgreement], next_moves: ['Send the proposal'],
    conflicts: [{ new_index: 0, previous_call_id: randomUUID(), previous_index: 0, note: 'The price changed since last time' }],
  });
  for (const column of ['agreements', 'next_moves', 'conflicts']) assert.ok(!SECRET.test(await rawColumn(id, column)), `${column} is ciphertext`);
  const { body } = await api('/api/briefing', o.token);
  assert.equal(body.money.length, 1, 'the sealed price is found');
  assert.deepEqual([body.money[0].subject, body.money[0].value, body.money[0].quote, body.money[0].line, body.money[0].contact_name],
    ['Cement', '40,000 birr', 'Caller: The cement is 40,000 birr', 2, 'Sara']);
  assert.deepEqual([body.conflicts[0]?.note, body.conflicts[0]?.count], ['The price changed since last time', 1]);
  assert.deepEqual(body.next_moves.map(m => m.move), ['Send the proposal']);
});

test('promises are listed, marked done and reopened from sealed action items, with deadlines read in the owner time zone', async () => {
  const o = await signedIn('+15555553002', 'Africa/Nairobi');
  const id = await call(o, { action_items: [
    { task: 'Send the proposal', owner: 'User', due: '2099-01-01T09:00' },
    { task: 'Pay the deposit', owner: 'Caller', due: '2000-01-01' },
    { task: 'Unclear', owner: null },
  ] });
  assert.ok(!SECRET.test(await rawColumn(id, 'action_items')));
  const { body } = await api('/api/promises', o.token);
  assert.deepEqual(body.you_owe.map(p => [p.task, p.index, p.call_id, p.contact_name, p.due_at, p.overdue]),
    [['Send the proposal', 0, id, 'Sara', '2099-01-01T06:00:00.000Z', false]]);
  assert.deepEqual(body.waiting_on.map(p => [p.task, p.index, p.overdue]), [['Pay the deposit', 1, true]]);
  assert.equal((await api(`/api/promises/${id}/0`, o.token, { method: 'POST', body: { status: 'done' } })).status, 200);
  assert.equal((await api(`/api/promises/${id}/9`, o.token, { method: 'POST', body: { status: 'done' } })).status, 404, 'no such item');
  assert.equal((await api('/api/promises', o.token)).body.you_owe.length, 0);
  await api(`/api/promises/${id}/0`, o.token, { method: 'POST', body: { status: 'open' } });
  assert.equal((await api('/api/promises', o.token)).body.you_owe.length, 1);
});

test('the call, its notes file and the data export all read sealed facts back as normal', async () => {
  const o = await signedIn('+15555553003');
  const facts = { next_moves: ['Send the proposal'], key_points: ['Cement is 40,000 birr'], agreements: [priceAgreement],
    action_items: [{ task: 'Email the quote', owner: 'User' }] };
  const id = await call(o, facts);
  const { body } = await api(`/api/calls/${id}`, o.token);
  assert.deepEqual([body.next_moves, body.key_points, body.agreements], [facts.next_moves, facts.key_points, facts.agreements]);
  assert.deepEqual(body.action_items, facts.action_items);
  const notes = await (await fetch(`${origin}/api/calls/${id}/notes`, { headers: { Authorization: `Bearer ${o.token}` } })).text();
  assert.match(notes, /Send the proposal/);
  assert.match(notes, /Email the quote/);
  const exported = (await buildExport(o.id)).calls.find(c => c.id === id);
  assert.deepEqual([exported.next_moves, exported.key_points, exported.agreements], [facts.next_moves, facts.key_points, facts.agreements]);
});

test('the memory check compares sealed earlier agreements and stores the contradiction it finds sealed', async () => {
  const o = await signedIn('+15555553004');
  const earlier = await call(o, { agreements: [{ ...priceAgreement, value: '38,000 birr' }] }, { days: 3 });
  const now = await call(o, { agreements: [priceAgreement] });
  llmReply = { conflicts: [{ new: 'N1', previous: 'P1', note: 'The price changed from 38,000 to 40,000' }] };
  const found = await checkConsistency(now);
  assert.equal(found.length, 1, 'the sealed earlier call was found');
  assert.ok(!SECRET.test(await rawColumn(now, 'conflicts')), 'the contradiction is stored as ciphertext');
  const { body } = await api(`/api/calls/${now}`, o.token);
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].note, 'The price changed from 38,000 to 40,000');
  assert.equal(body.conflicts[0].before.call_id, earlier);
  assert.equal(body.conflicts[0].before.value, '38,000 birr');
});

test('the catch-up job seals facts stored before this change, readers keep working, and a re-run finds nothing', async () => {
  const o = await signedIn('+15555553005');
  const id = await call(o, { next_moves: ['Send the proposal'], action_items: [{ task: 'Email the quote', owner: 'User' }],
    key_points: ['Cement is 40,000 birr'], agreements: [priceAgreement], conflicts: [] }, { sealed: false });
  assert.match(await rawColumn(id, 'agreements'), /cement/i, 'starts as plaintext');
  // Right after a deploy old rows are still plaintext while new ones are sealed: readers must cope with both.
  await call(o, { action_items: [{ task: 'Send the proposal', owner: 'Caller' }], agreements: [{ ...priceAgreement, kind: 'amount' }] });
  const mixed = await api('/api/promises', o.token);
  assert.deepEqual([mixed.body.you_owe.length, mixed.body.waiting_on.length], [1, 1]);
  assert.equal((await api('/api/briefing', o.token)).body.money.length, 2);
  const first = await encryptExisting({ limit: 50 });
  assert.ok(first.calls >= 1);
  for (const column of FACTS) {
    assert.ok(!SECRET.test(await rawColumn(id, column)), `${column} sealed`);
    assert.equal((await db.query(`SELECT jsonb_typeof(${column}) AS t FROM calls WHERE id=$1`, [id])).rows[0].t, 'string');
  }
  const detail = (await api(`/api/calls/${id}`, o.token)).body;
  assert.deepEqual([detail.next_moves, detail.agreements, detail.key_points], [['Send the proposal'], [priceAgreement], ['Cement is 40,000 birr']]);
  assert.equal((await api('/api/promises', o.token)).body.you_owe.length, 1);
  assert.equal((await api('/api/briefing', o.token)).body.money.length, 2, 'both prices, whether they were sealed by the job or on arrival');
  const again = await encryptExisting({ limit: 50 });
  assert.deepEqual([again.calls, again.pending.calls], [0, 0]);
});

test('the admin check counts unsealed conversation facts, and drops to zero once the catch-up job has run', async () => {
  const o = await signedIn('+15555553006');
  await call(o, { next_moves: ['Send the proposal'] }, { sealed: false });
  const count = async () => (await compliance()).checks.find(c => c.id === 'encryption').count;
  assert.ok(await count() >= 1, 'plaintext next steps are noticed');
  await encryptExisting({ limit: 50 });
  assert.equal(await count(), 0);
});
