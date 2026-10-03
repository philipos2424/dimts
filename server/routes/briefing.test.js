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
let llmCalls = 0;
mock.module('../services/llm.js', { namedExports: { completeJson: async () => { llmCalls++; return '{"answer":"","citations":[]}'; } } });
const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('exp.host')) { pushes.push(JSON.parse(init.body)); return new Response('{"data":[]}', { status: 200 }); }
  return realFetch(url, init);
};
process.env.CRON_SECRET = 'cron-secret-for-tests-0123456789';
const { createApp } = await import('../create-app.js');
const { isPlanningQuestion } = await import('../services/briefing.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { globalThis.fetch = realFetch; await new Promise(r => server.close(r)); await db.close(); });

async function signedIn(phone, language = 'en') {
  const user = (await db.query('INSERT INTO users(phone,language) VALUES($1,$2) RETURNING id', [phone, language])).rows[0];
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hash, user.id]);
  return { id: user.id, token, hash };
}
async function call(userId, name, { days = 1, actions = [], agreements = [], conflicts = null, moves = [] } = {}) {
  const contact = (await db.query('INSERT INTO contacts(user_id,phone,display_name) VALUES($1,$2,$3) RETURNING id',
    [userId, `+1555${Math.floor(1000000 + Math.random() * 8999999)}`, name])).rows[0];
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,direction,summary,transcript,duration_sec,
      action_items,agreements,conflicts,next_moves,created_at)
    VALUES($1,'+1','+2',$2,'ready','outbound','A call.','User: hi',120,$3,$4,$5,$6,now()-make_interval(days=>$7)) RETURNING id`,
  [userId, contact.id, JSON.stringify(actions), JSON.stringify(agreements), conflicts && JSON.stringify(conflicts), JSON.stringify(moves), days])).rows[0].id;
}
const get = (token, path) => realFetch(origin + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  .then(async r => ({ status: r.status, body: await r.json() }));
const ask = (token, question) => realFetch(origin + '/api/ask', { method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) })
  .then(async r => r.json());

test('the briefing puts money promises first, then the oldest, and shows agreed prices with their quote', async () => {
  const o = await signedIn('+15555552001');
  await call(o.id, 'Selam', { days: 6, actions: [{ task: 'Call back about the shelves', owner: 'User' }] });
  const priced = await call(o.id, 'Abebe', { days: 2,
    actions: [{ task: 'Send the quote for 200 bags', owner: 'User' }, { task: 'Pay the 1,200 balance by Friday', owner: 'Caller' }],
    agreements: [{ kind: 'price', subject: 'Cement', value: '450 birr per bag', quote: 'Caller: 450 birr per bag.', line: 2, start: 3.5 },
      { kind: 'date', subject: 'Delivery', value: 'Friday', quote: 'Caller: Friday.', line: 3, start: 5 }],
    conflicts: [{ note: 'said 450; agreed 500 on 3 Oct' }], moves: ['Confirm the price in writing'] });
  await call(o.id, 'Old', { days: 40, agreements: [{ kind: 'price', subject: 'Old', value: '1', quote: 'x', line: 1 }] });
  const { status, body } = await get(o.token, '/api/briefing');
  assert.equal(status, 200);
  assert.deepEqual(body.you_owe.map(p => p.task), ['Send the quote for 200 bags', 'Call back about the shelves'], 'money first');
  assert.equal(body.waiting_on[0].task, 'Pay the 1,200 balance by Friday');
  assert.deepEqual(body.money.map(m => [m.call_id, m.value, m.quote, m.start]), [[priced, '450 birr per bag', 'Caller: 450 birr per bag.', 3.5]],
    'only prices and amounts from the last two weeks');
  assert.equal(body.conflicts[0].note, 'said 450; agreed 500 on 3 Oct');
  assert.equal(body.calls_this_week, 2);
  assert.equal(body.minutes_this_week, 4);
});

test('another owner never sees these calls', async () => {
  const stranger = await signedIn('+15555552002');
  const { body } = await get(stranger.token, '/api/briefing');
  assert.equal(body.totals.you_owe + body.totals.waiting_on + body.totals.money, 0);
  assert.equal((await get(null, '/api/briefing')).status, 401);
});

test('"what should I do this week?" is answered from the briefing, in the owner\'s language, without a model call', async () => {
  const o = await signedIn('+15555552003', 'am');
  await call(o.id, 'Kebede', { actions: [{ task: 'ዋጋውን ላክ', owner: 'User' }],
    agreements: [{ kind: 'amount', subject: 'ቀሪ ክፍያ', value: '1,200', quote: 'Caller: 1,200', line: 1, start: 1 }] });
  const before = llmCalls;
  const reply = await ask(o.token, 'በዚህ ሳምንት ምን ላድርግ?');
  assert.equal(reply.grounded, true);
  assert.match(reply.answer, /^በዚህ ሳምንት:/);
  assert.match(reply.answer, /ለKebede ቃል የገቡት፦ ዋጋውን ላክ/);
  assert.equal(reply.citations[0].quote, 'Caller: 1,200');
  assert.equal(llmCalls, before);
  assert.equal(isPlanningQuestion('What should I do this week?'), true);
  assert.equal(isPlanningQuestion('What price did Abebe agree to?'), false);
});

test('the Monday job needs the cron secret and only notifies owners with something waiting', async () => {
  const busy = await signedIn('+15555552004'), quiet = await signedIn('+15555552005');
  await call(busy.id, 'Tigist', { actions: [{ task: 'Pay the deposit', owner: 'Caller' }] });
  for (const owner of [busy, quiet]) {
    await db.query('INSERT INTO notification_devices(user_id,session_hash,push_token) VALUES($1,$2,$3)',
      [owner.id, owner.hash, `ExponentPushToken[${owner.id.replace(/-/g, '').slice(0, 20)}]`]);
  }
  assert.equal((await get(null, '/api/cron/weekly-briefing')).status, 401);
  const wrong = await realFetch(origin + '/api/cron/weekly-briefing', { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  pushes.length = 0;
  const ran = await realFetch(origin + '/api/cron/weekly-briefing', { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }).then(r => r.json());
  assert.ok(ran.sent >= 1);
  const messages = pushes.flat();
  assert.ok(messages.some(m => m.to.includes(busy.id.replace(/-/g, '').slice(0, 20)) && m.title === 'This week' && /1 to chase/.test(m.body)));
  assert.ok(!messages.some(m => m.to.includes(quiet.id.replace(/-/g, '').slice(0, 20))), 'nothing waiting, no push');
});
