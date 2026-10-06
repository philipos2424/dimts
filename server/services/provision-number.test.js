import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
process.env.PUBLIC_BASE_URL = 'https://caller.example.com';
process.env.CARRIER = 'telnyx';
process.env.TELNYX_API_KEY = 'KEY_TEST';
process.env.TELNYX_TEXML_APP_ID = 'texml-app-1';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, params) => db.query(sql, params),
  queryOne: async (sql, params) => (await db.query(sql, params)).rows[0],
  withTransaction: work => db.transaction(work),
} });
const { buyPoolNumber, countryFor } = await import('./provision-number.js');
const { claimNumber } = await import('../db/claim-number.js');
const { assignNumberAfterUpgrade } = await import('./billing.js');
const url = 'https://caller.example.com/twiml/incoming';
const newUser = async (phone, tier = 'pro') => (await db.query('INSERT INTO users(phone,tier) VALUES($1,$2) RETURNING id', [phone, tier])).rows[0].id;
test.after(() => db.close());

test('numbers are local to the owner where we sell them, otherwise from the first listed country', () => {
  assert.equal(countryFor('+447700900123', ['US', 'GB']), 'GB');
  assert.equal(countryFor('+14155550100', ['US', 'GB']), 'US');
  assert.equal(countryFor('+251911000000', ['US', 'GB']), 'US');
  assert.equal(countryFor('+447700900123', ['US']), 'US');
  assert.equal(countryFor('+14165550100', ['US', 'CA']), 'CA');
  assert.equal(countryFor('+14165550100', ['US']), 'US');
  assert.equal(countryFor('+14155550100', ['CA', 'US']), 'US');
});

test('a +1 owner gets a number in their own area code, or any local one when it has none left', async () => {
  const searches = [];
  let orders = 0;
  mock.method(globalThis, 'fetch', async (href, init) => {
    const query = new URL(String(href)).searchParams;
    if (init.method === 'GET') searches.push(query.get('filter[national_destination_code]'));
    const data = init.method === 'GET'
      ? (query.get('filter[national_destination_code]') === '415' ? [{ phone_number: '+14155550111' }] : [])
        .concat(query.has('filter[national_destination_code]') ? [] : [{ phone_number: '+12125550111' }])
      : { id: 'order-2', status: 'pending', phone_numbers: [{ id: `num-area-${++orders}`, phone_number: init.body && JSON.parse(init.body).phone_numbers[0].phone_number }] };
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  try {
    assert.equal(await buyPoolNumber({ userId: await newUser('+14155550210'), ownerPhone: '+14155550210', voiceUrl: url }), '+14155550111');
    assert.equal(await buyPoolNumber({ userId: await newUser('+19075550211'), ownerPhone: '+19075550211', voiceUrl: url }), '+12125550111');
    assert.equal(await buyPoolNumber({ userId: await newUser('+447700900212'), ownerPhone: '+447700900212', voiceUrl: url }), '+12125550111');
  } finally { mock.restoreAll(); await db.query("DELETE FROM agent_number_pool WHERE provider_sid LIKE 'num-area-%'"); }
  assert.deepEqual(searches, ['415', '907', null, null]);
});

test('an empty pool buys one number, routes it to Dimts and gives it to the claimant', async () => {
  const userId = await newUser('+15555550201');
  const calls = [];
  mock.method(globalThis, 'fetch', async (href, init) => {
    calls.push({ href: String(href), method: init.method, body: init.body && JSON.parse(init.body) });
    const data = init.method === 'GET'
      ? [{ phone_number: '+15555550299' }]
      : { id: 'order-1', status: 'pending', phone_numbers: [{ id: 'num-1', phone_number: '+15555550299', status: 'pending' }] };
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  try {
    assert.deepEqual(await claimNumber(userId, url), { agent_number: '+15555550299' });
  } finally { mock.restoreAll(); }
  assert.match(calls[0].href, /available_phone_numbers\?.*filter%5Bcountry_code%5D=US/);
  assert.deepEqual(calls[1].body, { phone_numbers: [{ phone_number: '+15555550299' }], connection_id: 'texml-app-1' });
  const pooled = (await db.query("SELECT provider_sid, voice_url FROM agent_number_pool WHERE phone='+15555550299'")).rows[0];
  assert.deepEqual(pooled, { provider_sid: 'num-1', voice_url: url });
});

test('a free pool number is used before buying, and a failed purchase leaves the user without one', async () => {
  await db.query("INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES('+15555550298','PN_STOCK',$1)", [url]);
  let bought = 0;
  const buy = async () => { bought++; return null; };
  assert.equal((await claimNumber(await newUser('+15555550202'), url, { buy })).agent_number, '+15555550298');
  const unlucky = await newUser('+15555550203');
  await assert.rejects(claimNumber(unlucky, url, { buy }), { code: 'number_pool_empty' });
  assert.equal(bought, 1);
  assert.equal((await db.query('SELECT agent_number FROM users WHERE id=$1', [unlucky])).rows[0].agent_number, null);
});

test('purchases are capped per account', async () => {
  const userId = await newUser('+15555550204');
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(buyPoolNumber({ userId, ownerPhone: '+15555550204', voiceUrl: url }), { code: 'number_pool_empty' });
    await assert.rejects(buyPoolNumber({ userId, ownerPhone: '+15555550204', voiceUrl: url }), { code: 'too_many_requests' });
  } finally { mock.restoreAll(); }
});

test('a new paid subscription assigns a number; Free accounts and existing holders are left alone', async () => {
  const claimed = [];
  const claim = async id => { claimed.push(id); return { agent_number: '+15555550297' }; };
  const db2 = { queryOne: async (sql, params) => (await db.query(sql, params)).rows[0] };
  const pro = await newUser('+15555550205');
  const free = await newUser('+15555550206', 'free');
  const holder = await newUser('+15555550207');
  await db.query("UPDATE users SET agent_number='+15555550296' WHERE id=$1", [holder]);
  const event = (id, type = 'subscription.active') => ({ type, data: { customer: { external_id: id } } });
  assert.deepEqual(await assignNumberAfterUpgrade(event(pro), db2, claim), { agent_number: '+15555550297' });
  assert.equal(await assignNumberAfterUpgrade(event(free), db2, claim), null);
  assert.equal(await assignNumberAfterUpgrade(event(holder), db2, claim), null);
  assert.equal(await assignNumberAfterUpgrade(event(pro, 'order.paid'), db2, claim), null);
  assert.deepEqual(claimed, [pro]);
});
