import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
} });
let reply, prompts = [], fail = false;
mock.module('./llm.js', { namedExports: { completeJson: async (system, input) => {
  prompts.push({ system, input });
  if (fail) throw new Error('model down');
  return JSON.stringify(reply);
} } });
const { checkConsistency } = await import('./consistency.js');
const { contactContext } = await import('../db/call-context.js');
test.after(() => db.close());
test.beforeEach(() => { prompts = []; fail = false; });

const price = value => ({ kind: 'price', subject: 'unit price', value, said_by: 'Caller', quote: `Caller: ${value} per unit`, line: 1, start: 4 });
async function owner(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const contact = (await db.query("INSERT INTO contacts(user_id,phone,display_name) VALUES($1,'+15555550900','Abebe') RETURNING id", [user.id])).rows[0];
  return { user: user.id, contact: contact.id };
}
async function call(o, agreements, daysAgo = 0) {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,summary,agreements,created_at)
    VALUES($1,'+1','+15555550900',$2,'ready','s',$3,now()-make_interval(days=>$4)) RETURNING id`,
  [o.user, o.contact, JSON.stringify(agreements), daysAgo])).rows[0].id;
}
const conflicts = async id => (await db.query('SELECT conflicts FROM calls WHERE id=$1', [id])).rows[0].conflicts;

test('a first call with this person never asks the model', async () => {
  const o = await owner('+15555550901');
  const id = await call(o, [price('450 birr')]);
  assert.deepEqual(await checkConsistency(id), []);
  assert.equal(prompts.length, 0);
});

test('a contradiction with an earlier call is stored with that call and agreement', async () => {
  const o = await owner('+15555550902');
  const earlier = await call(o, [price('500 birr')], 3);
  const today = await call(o, [price('450 birr')]);
  reply = { conflicts: [{ new: 'N1', previous: 'P1', note: 'Price changed from 500 to 450 birr.' }] };
  const result = await checkConsistency(today);
  assert.deepEqual(result, [{ new_index: 0, previous_call_id: earlier, previous_index: 0, note: 'Price changed from 500 to 450 birr.' }]);
  assert.deepEqual(await conflicts(today), result);
  assert.ok(!prompts[0].input.includes(earlier), 'real call ids are never shown to the model');
});

test('labels the server never sent, and other people\'s calls, are dropped', async () => {
  const o = await owner('+15555550903'), stranger = await owner('+15555550904');
  await call(o, [price('500 birr')], 2);
  const foreign = await call(stranger, [price('900 birr')], 1);
  const today = await call(o, [price('450 birr')]);
  reply = { conflicts: [{ new: 'N1', previous: 'P9', note: 'x' }, { new: 'N7', previous: 'P1', note: 'x' },
    { new: 'N1', previous: foreign, note: 'x' }, { new: 'N1', previous: 'P1' }] };
  assert.deepEqual(await checkConsistency(today), []);
  assert.ok(!prompts[0].input.includes('900 birr'), 'another user\'s agreements never reach the prompt');
});

test('a model failure leaves the call ready and unflagged', async () => {
  const o = await owner('+15555550905');
  await call(o, [price('500 birr')], 2);
  const today = await call(o, [price('450 birr')]);
  fail = true;
  assert.deepEqual(await checkConsistency(today), []);
  assert.equal(await conflicts(today), null);
});

test('the briefing before a call includes what was agreed last time', async () => {
  const o = await owner('+15555550906');
  await call(o, [price('500 birr')], 2);
  const context = await contactContext(o.user, '+15555550900');
  assert.deepEqual(context.previous_calls[0].agreements, [price('500 birr')]);
});
