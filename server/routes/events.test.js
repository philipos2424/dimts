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
process.env.POSTHOG_KEY = 'phc_test';
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('posthog')) { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{}'); }
  return realFetch(url, init);
};
const { createApp } = await import('../create-app.js');
const { capture } = await import('../lib/analytics.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { globalThis.fetch = realFetch; await new Promise(r => server.close(r)); await db.close(); });

async function signedIn(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  return { id: user.id, token };
}
const post = (token, body) => realFetch(origin + '/api/events', { method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('the app may report only allowlisted events, keyed by account ID, to the EU host', async () => {
  const o = await signedIn('+15555552001');
  assert.equal((await post(o.token, { event: 'paywall_viewed', phone: '+15555552001' })).status, 202);
  assert.equal((await post(o.token, { event: 'subscribed' })).status, 400, 'payments are recorded from Polar, not the app');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /^https:\/\/eu\.i\.posthog\.com\/capture\/$/);
  assert.equal(sent[0].body.distinct_id, o.id);
  assert.equal(sent[0].body.event, 'paywall_viewed');
  assert.ok(!JSON.stringify(sent[0].body).includes('5555552001'), 'no phone number leaves the server');
});

test('analytics never sends long or structured values, and does nothing without a key', async () => {
  sent.length = 0;
  await capture('u1', 'call_started', { direction: 'outbound', transcript: 'x'.repeat(200), nested: { a: 1 } });
  assert.deepEqual(Object.keys(sent[0].body.properties).sort(), ['$process_person_profile', 'direction']);
  delete process.env.POSTHOG_KEY;
  assert.equal(await capture('u1', 'call_started'), false);
  process.env.POSTHOG_KEY = 'phc_test';
});
