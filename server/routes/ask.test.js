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
let prompts = [], reply;
mock.module('../services/llm.js', { namedExports: { completeJson: async (system, input) => {
  prompts.push({ system, input }); return JSON.stringify(reply);
} } });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
test.beforeEach(() => { prompts = []; });

async function signedIn(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  return { id: user.id, token };
}
async function seed(userId, name, transcript, { data = null, url = null, days = 0 } = {}) {
  const contact = (await db.query('INSERT INTO contacts(user_id,phone,display_name) VALUES($1,$2,$3) RETURNING id',
    [userId, `+1555555${Math.floor(1000 + Math.random() * 8999)}`, name])).rows[0];
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,direction,summary,transcript,
      transcript_data,recording_url,transcript_recording_url,created_at)
    VALUES($1,'+1','+2',$2,'ready','outbound','A call.',$3,$4,$5,$5,now()-make_interval(days=>$6)) RETURNING id`,
  [userId, contact.id, transcript, data && JSON.stringify(data), url, days])).rows[0].id;
}
const ask = (token, question) => fetch(origin + '/api/ask', { method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('a new user with no calls gets an honest not-found answer without any model call', async () => {
  const o = await signedIn('+15555551201');
  const { status, body } = await ask(o.token, 'What price did Abebe agree to?');
  assert.equal(status, 200);
  assert.deepEqual(body, { answer: null, grounded: false, citations: [] });
  assert.equal(prompts.length, 0);
});

test('answers cite verified moments; the model only ever sees labels, never another user\'s calls', async () => {
  const o = await signedIn('+15555551202'), stranger = await signedIn('+15555551203');
  const data = { transcripts: [
    { text: 'We need 200 units.', words: [{ text: 'We', start: 1 }, { text: 'need', start: 1.2 }, { text: '200', start: 1.4 }, { text: 'units.', start: 1.6 }] },
    { text: 'Fine, 450 birr per unit.', words: [{ text: 'Fine,', start: 3 }, { text: '450', start: 3.2 }, { text: 'birr', start: 3.4 }, { text: 'per', start: 3.6 }, { text: 'unit.', start: 3.8 }] },
  ] };
  const priced = await seed(o.id, 'Abebe', 'User: We need 200 units.\nCaller: Fine, 450 birr per unit.', { data, url: 'https://r/1' });
  await seed(stranger.id, 'Abebe', 'Caller: STRANGER-SECRET 999 birr.');
  reply = { answer: '450 birr per unit.', citations: [{ call: 'C1', line: 2 }, { call: 'C1', line: 40 }, { call: 'C9', line: 1 }] };
  const { body } = await ask(o.token, 'What price did Abebe agree to in birr?');
  assert.equal(body.grounded, true);
  assert.equal(body.answer, '450 birr per unit.');
  assert.deepEqual(body.citations.map(c => [c.call_id, c.line, c.quote, c.start, c.contact_name]),
    [[priced, 2, 'Caller: Fine, 450 birr per unit.', 3, 'Abebe']]);
  const input = prompts[0].input;
  assert.match(input, /C1/); assert.ok(!input.includes(priced), 'real ids stay on the server');
  assert.ok(!input.includes('STRANGER-SECRET'));
});

test('an answer with no valid citation is withheld', async () => {
  const o = await signedIn('+15555551204');
  await seed(o.id, 'Sara', 'Caller: The proposal is due Friday.');
  reply = { answer: 'Probably 1 million.', citations: [{ call: 'C1', line: 9 }] };
  const { body } = await ask(o.token, 'What is the budget?');
  assert.deepEqual(body, { answer: null, grounded: false, citations: [] });
});

test('long transcripts are trimmed for the model but keep their original line numbers', async () => {
  const o = await signedIn('+15555551205');
  const lines = Array.from({ length: 300 }, (_, i) => `Caller: filler line ${i + 1}`);
  lines[249] = 'Caller: the warehouse code is ZETA-77.';
  await seed(o.id, 'Dawit', lines.join('\n'));
  reply = { answer: 'ZETA-77', citations: [{ call: 'C1', line: 250 }] };
  const { body } = await ask(o.token, 'warehouse code ZETA-77');
  assert.equal(body.grounded, true);
  assert.equal(body.citations[0].quote, 'Caller: the warehouse code is ZETA-77.');
  assert.ok(prompts[0].input.split('\n').filter(l => /^\[\d+\]/.test(l)).length <= 120);
});

test('questions must be 3 to 500 characters and are limited to 30 an hour', async () => {
  const o = await signedIn('+15555551206');
  assert.equal((await ask(o.token, 'hi')).status, 400);
  assert.equal((await ask(o.token, 'x'.repeat(501))).status, 400);
  for (let i = 0; i < 30; i++) await ask(o.token, 'anything at all');
  assert.equal((await ask(o.token, 'anything at all')).status, 429);
});
