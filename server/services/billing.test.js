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
const { applyPolarEvent, billingState, liveSubscriptionIds } = await import('./billing.js');
const { reserveCallInTransaction } = await import('../db/reserve-call.js');
const { FINISH_CALL_SQL } = await import('../db/finish-call.js');
test.after(() => db.close());

const newUser = async phone => (await db.query("INSERT INTO users(phone,terms_version) VALUES($1,'2026-10-07') RETURNING *", [phone])).rows[0];
const reload = async user => (await db.query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
const sub = (user, fields) => ({ id: 'sub_1', status: 'active', product_id: ids.pro_month, current_period_end: '2026-11-04T00:00:00Z',
  cancel_at_period_end: false, modified_at: '2026-10-04T10:00:00Z', customer: { external_id: user.id }, ...fields });

test('subscription events set the plan once, in order, and revocation returns the user to free', async () => {
  const user = await newUser('+12025550111');
  assert.equal(await applyPolarEvent('wh_1', { type: 'subscription.active', data: sub(user) }), 'applied');
  assert.equal((await reload(user)).tier, 'pro');
  assert.equal(await applyPolarEvent('wh_1', { type: 'subscription.active', data: sub(user, { status: 'canceled' }) }), 'duplicate');
  assert.equal((await reload(user)).tier, 'pro');
  // An upgrade, then a stale delivery from before it.
  await applyPolarEvent('wh_2', { type: 'subscription.updated', data: sub(user, { product_id: ids.business_year, modified_at: '2026-10-05T00:00:00Z' }) });
  await applyPolarEvent('wh_3', { type: 'subscription.updated', data: sub(user, { modified_at: '2026-10-04T11:00:00Z' }) });
  assert.equal((await reload(user)).tier, 'business');
  const state = await billingState(await reload(user), { queryOne: async (s, p) => (await db.query(s, p)).rows[0] });
  assert.deepEqual(state.subscription, { plan: 'business', interval: 'year', status: 'active', renews_at: new Date('2026-11-04T00:00:00Z'), ends_at: null });
  assert.equal(state.minutes_included, 1500);
  assert.deepEqual(await liveSubscriptionIds(user.id), ['sub_1']);
  await applyPolarEvent('wh_4', { type: 'subscription.revoked', data: sub(user, { status: 'canceled', modified_at: '2026-10-06T00:00:00Z' }) });
  assert.equal((await reload(user)).tier, 'free');
  assert.deepEqual(await liveSubscriptionIds(user.id), []);
});

test('events for unknown customers or products change nothing', async () => {
  const user = await newUser('+12025550112');
  assert.equal(await applyPolarEvent('wh_10', { type: 'subscription.active', data: sub(user, { id: 'sub_x', customer: { external_id: '00000000-0000-4000-8000-00000000dead' } }) }), 'unknown_customer');
  assert.equal(await applyPolarEvent('wh_11', { type: 'subscription.active', data: sub(user, { id: 'sub_y', product_id: '00000000-0000-4000-8000-0000000000ff' }) }), 'ignored_product');
  assert.equal(await applyPolarEvent('wh_12', { type: 'checkout.created', data: {} }), 'ignored_type');
  assert.equal((await reload(user)).tier, 'free');
});

test('credit packs add credits once; refunds take back their share; calls spend them', async () => {
  const user = await newUser('+12025550113');
  const order = { id: 'ord_1', product_id: ids.credits_25, total_amount: 2500, refunded_amount: 0, customer: { external_id: user.id } };
  await applyPolarEvent('wh_20', { type: 'order.paid', data: order });
  await applyPolarEvent('wh_21', { type: 'order.paid', data: order }); // a second delivery of the same order
  const balance = async () => (await db.query('SELECT COALESCE(sum(amount_cents),0)::int AS c FROM credit_ledger WHERE user_id=$1', [user.id])).rows[0].c;
  assert.equal(await balance(), 2600);
  await applyPolarEvent('wh_22', { type: 'order.refunded', data: { ...order, refunded_amount: 1250 } });
  await applyPolarEvent('wh_23', { type: 'order.refunded', data: { ...order, refunded_amount: 1250 } });
  assert.equal(await balance(), 1300);
  await applyPolarEvent('wh_24', { type: 'order.paid', data: { ...order, id: 'ord_sub', product_id: ids.pro_month } });
  assert.equal(await balance(), 1300, 'subscription orders do not grant credits');

  // A US owner calling Ethiopia: 50 credits a minute on top of plan minutes.
  const reserve = (key, dest) => db.transaction(tx => reserveCallInTransaction(tx, user, dest, true, key));
  const { call } = await reserve('call-et-1', '+251911234567');
  assert.equal(call.surcharge_cents, 50);
  assert.equal(call.max_duration_sec, 1440, '1300 credits: 5 trial minutes at 50, then 19 at 50 + 3 over plan; no grace on paid surcharges');
  await db.query(FINISH_CALL_SQL, [call.id, 61, true, 'Dial completed', 'failed', '2026-10']);
  await db.query(FINISH_CALL_SQL, [call.id, 61, true, 'Dial completed', 'failed', '2026-10']);
  assert.equal(await balance(), 1200, 'two started minutes, charged once');
  assert.equal((await db.query('SELECT plan_seconds FROM calls WHERE id=$1', [call.id])).rows[0].plan_seconds, 61);

  // The 5 trial minutes used up: a US call continues on credits at the overage rate.
  await db.query("UPDATE calls SET plan_seconds=300, duration_sec=300 WHERE id=$1", [call.id]);
  const us = (await reserve('call-us-1', '+12025550199')).call;
  assert.equal(us.plan_seconds, 0);
  assert.equal(us.overage_cents, 3);
  await db.query(FINISH_CALL_SQL, [us.id, 300, true, 'Dial completed', 'failed', '2026-10']);
  assert.equal(await balance(), 1185);

  // A missed call costs nothing.
  const missed = (await reserve('call-us-2', '+12025550199')).call;
  await db.query(FINISH_CALL_SQL, [missed.id, 0, false, 'Dial no-answer', 'failed', '2026-10']);
  assert.equal(await balance(), 1185);
});

test('a call nobody can pay for is refused before it rings', async () => {
  const user = await newUser('+251911234500');
  await assert.rejects(db.transaction(tx => reserveCallInTransaction(tx, user, '+12025550199', true, 'call-et-out')),
    { status: 402, code: 'credits_required', message: /50 credits a minute/ });
});
