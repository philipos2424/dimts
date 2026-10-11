process.env.AUDIT_SALT = 'test-trial-secret-at-least-32-characters';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { PRODUCT_KEYS } from '../lib/polar-products.js';

const ids = Object.fromEntries(PRODUCT_KEYS.map((key, i) => [key, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`]));
process.env.POLAR_PRODUCTS = JSON.stringify(ids);
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
const { applyPolarEvent, billingState } = await import('./billing.js');
const { releaseExpiredNumbers } = await import('./release-numbers.js');
const { sendBalanceAlerts } = await import('./billing-alerts.js');
const { aggregateTelnyx, syncProviderCosts } = await import('./provider-costs.js');
const { reserveCallInTransaction } = await import('../db/reserve-call.js');
const { finishCall } = await import('../db/finish-call.js');
test.after(() => db.close());

const newUser = async phone => (await db.query("INSERT INTO users(phone,terms_version) VALUES($1,'2026-10-07') RETURNING *", [phone])).rows[0];
const reload = async user => (await db.query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
const sub = (user, fields) => ({ id: 'sub_grace', status: 'active', product_id: ids.pro_month, current_period_end: '2026-11-04T00:00:00Z',
  cancel_at_period_end: false, modified_at: '2026-10-06T00:00:00Z', customer: { external_id: user.id }, ...fields });
const direct = { queryOne: async (q, p) => (await db.query(q, p)).rows[0] };

test('dropping to Free keeps the business number 30 days; paying again cancels the release', async () => {
  const user = await newUser('+12025550120');
  await db.query(`INSERT INTO agent_number_pool(phone,provider_sid,voice_url,checked_at)
    VALUES('+15735550120','PN_GRACE','https://x/twiml/incoming',now()-interval '9 days')`);
  await db.query("UPDATE users SET agent_number='+15735550120' WHERE id=$1", [user.id]);
  await applyPolarEvent('wh_30', { type: 'subscription.active', data: sub(user) });
  assert.equal((await reload(user)).number_release_at, null);
  await applyPolarEvent('wh_31', { type: 'subscription.revoked', data: sub(user, { status: 'canceled', modified_at: '2026-10-07T00:00:00Z' }) });
  const graced = await reload(user);
  assert.equal(graced.tier, 'free');
  const days = (new Date(graced.number_release_at) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `release in 30 days, got ${days}`);
  assert.equal((await billingState(graced, direct)).business_number, '+15735550120');
  assert.deepEqual(await releaseExpiredNumbers(), { released: 0 }, 'nothing released during the grace');
  await applyPolarEvent('wh_32', { type: 'subscription.active', data: sub(user, { id: 'sub_back', modified_at: '2026-10-08T00:00:00Z' }) });
  assert.equal((await reload(user)).number_release_at, null, 'paying again keeps the number');
  await applyPolarEvent('wh_33', { type: 'subscription.revoked', data: sub(user, { id: 'sub_back', status: 'canceled', modified_at: '2026-10-09T00:00:00Z' }) });
  await db.query("UPDATE users SET number_release_at=now()-interval '1 minute' WHERE id=$1", [user.id]);
  assert.deepEqual(await releaseExpiredNumbers(), { released: 1 });
  const after = await reload(user);
  assert.equal(after.agent_number, null);
  assert.equal(after.number_release_at, null);
  const pooled = (await db.query("SELECT checked_at FROM agent_number_pool WHERE phone='+15735550120'")).rows[0];
  assert.ok(Date.now() - new Date(pooled.checked_at) < 60_000, 'released number goes to the back of the queue');
});

test('every paid order is kept as revenue, with refunds', async () => {
  const user = await newUser('+12025550121');
  const order = { id: 'ord_rev', product_id: ids.pro_month_lite, currency: 'USD', total_amount: 700, tax_amount: 0, refunded_amount: 0,
    created_at: '2026-10-04T12:00:00Z', customer: { external_id: user.id } };
  await applyPolarEvent('wh_40', { type: 'order.paid', data: order });
  await applyPolarEvent('wh_41', { type: 'order.refunded', data: { ...order, refunded_amount: 700 } });
  const row = (await db.query("SELECT product_key,currency,total_amount,refunded_amount FROM payments WHERE order_id='ord_rev'")).rows[0];
  assert.deepEqual(row, { product_key: 'pro_month_lite', currency: 'usd', total_amount: 700, refunded_amount: 700 });
});

test('an owner with nothing left can still receive a message, free of charge', async () => {
  const user = await newUser('+251911234501');
  const inbound = options => db.transaction(tx => reserveCallInTransaction(tx, user, '+251911234502', true, 'incoming-VM1',
    { direction: 'inbound', callSid: 'v3:vm1', contactId: null, ...options }));
  await assert.rejects(inbound({}), { code: 'credits_required' });
  const { call } = await inbound({ voicemailOnly: true });
  assert.equal(call.status, 'missed');
  assert.equal(call.voicemail, true);
  assert.equal(call.max_duration_sec, 120);
  assert.equal(call.plan_seconds, 0);
  assert.equal(call.surcharge_cents, 0);
  assert.equal(call.overage_cents, 0);
  assert.ok(call.child_consent_at, 'owner consent from accepted terms still applies');
  // The missed voicemail row neither blocks the owner as "in progress" nor uses their minutes.
  await assert.rejects(db.transaction(tx => reserveCallInTransaction(tx, user, '+12025550199', true, 'after-vm')), { code: 'credits_required' });
  const state = await billingState(user, direct);
  assert.equal(state.minutes_used, 0);
});

test('balance alerts fire once per threshold, re-arm after a top-up, and stay quiet with no device', async () => {
  const pushes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { pushes.push(JSON.parse(init.body)); return new Response('{}'); };
  try {
    const user = await newUser('+12025550122');
    const token = 'b'.repeat(64);
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [token, user.id]);
    await db.query("INSERT INTO notification_devices(user_id,session_hash,push_token) VALUES($1,$2,'ExponentPushToken[abcdefghijkl]')", [user.id, token]);
    const used = seconds => db.query(`INSERT INTO calls(user_id,user_phone,destination,status,duration_sec,plan_seconds,max_duration_sec)
      VALUES($1,'+12025550122','+12025550199','ready',$2,$2,$2)`, [user.id, seconds]);
    await db.query("UPDATE users SET tier='pro' WHERE id=$1", [user.id]);
    await used(24600); // 410 of 500 Pro minutes
    assert.deepEqual(await sendBalanceAlerts(user.id), ['minutes80']);
    assert.deepEqual(await sendBalanceAlerts(user.id), [], 'once a month');
    await used(5400);
    assert.deepEqual(await sendBalanceAlerts(user.id), ['minutes100']);
    await db.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key)
      VALUES($1,1000,'purchase','alert-buy-1'),($1,-900,'call','alert-call-1')`, [user.id]);
    assert.deepEqual(await sendBalanceAlerts(user.id), ['credits_low']);
    assert.deepEqual(await sendBalanceAlerts(user.id), []);
    await db.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key)
      VALUES($1,1000,'purchase','alert-buy-2'),($1,-1000,'call','alert-call-2')`, [user.id]);
    assert.deepEqual(await sendBalanceAlerts(user.id), ['credits_low'], 're-armed by the second purchase');
    assert.equal(pushes.length, 4);
    assert.equal(pushes[0][0].to, 'ExponentPushToken[abcdefghijkl]');
    assert.match(pushes[0][0].body, /90 minutes left/);
    assert.deepEqual(pushes[0][0].data, { type: 'billing-minutes80' });
    const silent = await newUser('+12025550123');
    await db.query("UPDATE users SET tier='pro' WHERE id=$1", [silent.id]);
    await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,duration_sec,plan_seconds,max_duration_sec)
      VALUES($1,'+12025550123','+12025550199','ready',30000,30000,30000)`, [silent.id]);
    assert.deepEqual(await sendBalanceAlerts(silent.id), ['minutes100']);
    assert.equal(pushes.length, 4, 'no device, no push');
  } finally { globalThis.fetch = realFetch; }
});

test('finishing a call records what it cost us', async () => {
  const user = await newUser('+251911234503');
  await db.query("INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key) VALUES($1,5000,'purchase','cost-buy')", [user.id]);
  const { call } = await db.transaction(tx => reserveCallInTransaction(tx, user, '+251911234504', true, 'cost-call'));
  await finishCall(call, 120, 'completed', '2026-10');
  const row = (await db.query('SELECT est_cost_micros FROM calls WHERE id=$1', [call.id])).rows[0];
  assert.equal(Number(row.est_cost_micros), 1365400, 'two Ethiopian legs, recorded and transcribed, two minutes');
});

test('Telnyx detail records become one row per day, type and country; resyncing replaces', async () => {
  const rows = aggregateTelnyx('sip-trunking', [
    { started_at: '2026-10-02T23:59:00Z', country_code: 251, billed_sec: 60, cost: '0.3361' },
    { started_at: '2026-10-02T10:00:00Z', country_code: 251, billed_sec: 120, cost: '0.6722' },
    { started_at: '2026-10-03T00:01:00Z', country_code: 1, billed_sec: 0, cost: '0.0' },
  ]);
  assert.deepEqual(rows.map(r => [r.day, r.country_code, r.records, r.billed_sec, r.cost_micros]),
    [['2026-10-02', '251', 2, 180, 1008300], ['2026-10-03', '1', 1, 0, 0]]);
  assert.equal(aggregateTelnyx('verify', [{ created_at: '2026-10-02T01:00:00Z', rate: '0.03', count: 1 }])[0].cost_micros, 30000);

  assert.deepEqual(await syncProviderCosts({ fetchImpl: async () => { throw new Error('should not call'); } }), { skipped: 'telnyx_not_configured' });
  process.env.CARRIER = 'telnyx'; process.env.TELNYX_API_KEY = 'KEY_test';
  try {
    const now = new Date('2026-10-05T08:00:00Z');
    const records = { 'sip-trunking': [
      { started_at: '2026-10-01T05:00:00Z', country_code: 251, billed_sec: 60, cost: '0.3361' }, // oldest day may be partial: skipped
      { started_at: '2026-10-03T05:00:00Z', country_code: 251, billed_sec: 60, cost: '0.3361' },
      { started_at: '2026-10-05T05:00:00Z', country_code: 251, billed_sec: 60, cost: '0.3361' }, // today is partial: skipped
    ] };
    const fetchImpl = async url => {
      const type = new URL(url).searchParams.get('filter[record_type]');
      return new Response(JSON.stringify({ data: records[type] ?? [], meta: { total_pages: 1 } }));
    };
    const target = { withTransaction: work => db.transaction(work) };
    assert.deepEqual(await syncProviderCosts({ db: target, fetchImpl, now }), { written: 1 });
    assert.deepEqual(await syncProviderCosts({ db: target, fetchImpl, now }), { written: 1 });
    const stored = (await db.query('SELECT day::text AS day, country_code, cost_micros FROM provider_costs')).rows;
    assert.deepEqual(stored.map(r => [r.day, r.country_code, Number(r.cost_micros)]), [['2026-10-03', '251', 336100]], 'replaced, never doubled');
  } finally { delete process.env.CARRIER; delete process.env.TELNYX_API_KEY; }
});
