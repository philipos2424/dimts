import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { PRODUCT_KEYS } from '../lib/polar-products.js';

const ids = Object.fromEntries(PRODUCT_KEYS.map((key, i) => [key, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`]));
const signingKey = Buffer.from('route-test-signing-key');
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://calls.example.com', POLAR_PRODUCTS: JSON.stringify(ids),
  POLAR_ACCESS_TOKEN: 'polar_oat_test', POLAR_WEBHOOK_SECRET: `whsec_${signingKey.toString('base64')}` });
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
let user = (await db.query("INSERT INTO users(phone) VALUES('+447700900123') RETURNING *")).rows[0];
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
mock.module('../lib/users.js', { namedExports: {
  resolveUser: async () => user, currentMonth: () => '2026-10',
  HttpError: class extends Error { constructor(status, code, message) { super(message ?? code); this.status = status; this.code = code; } },
} });
mock.module('../lib/rate-limit.js', { namedExports: { hit: async () => {} } });
mock.module('../lib/audit.js', { namedExports: { audit: async () => {} } });
const checkouts = [], portals = [];
mock.module('../services/polar.js', { namedExports: {
  billingConfigured: () => true,
  createCheckout: async args => { checkouts.push(args); return { id: 'co_1', url: 'https://polar.example/checkout/co_1' }; },
  createPortalSession: async (...args) => { portals.push(args); return { url: 'https://polar.example/portal' }; },
} });
const { billingRouter, polarWebhookRouter } = await import('./billing.js');
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/api/billing', billingRouter);
app.use('/webhooks/polar', polarWebhookRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); return db.close(); });
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the plans screen gets the price in the local currency for the verified number', async () => {
  const body = await (await fetch(`${base}/api/billing`)).json();
  assert.equal(body.tier, 'free');
  assert.equal(body.minutes_included, 0, 'a free account that has not started its trial has no plan minutes yet');
  assert.equal(body.trial_used, false);
  assert.equal(body.catalog.currency, 'gbp');
  assert.deepEqual(body.catalog.plans.find(p => p.id === 'pro').prices.month, { amount: 1600, currency: 'gbp' });
  assert.equal(body.purchasable, true);
});

test('checkout uses the product for the region and charges the currency shown', async () => {
  const res = await post('/api/billing/checkout', { item: 'pro', interval: 'year' });
  assert.deepEqual(await res.json(), { kind: 'checkout', url: 'https://polar.example/checkout/co_1' });
  assert.equal(checkouts.at(-1).productId, ids.pro_year);
  assert.equal(checkouts.at(-1).currency, 'gbp');
  assert.equal(checkouts.at(-1).userId, user.id);
  assert.equal(checkouts.at(-1).successUrl, 'https://calls.example.com/plans?checkout=done');
  user = { ...user, phone: '+251911234567' };
  await post('/api/billing/checkout', { item: 'business', interval: 'month' });
  assert.equal(checkouts.at(-1).productId, ids.business_month_lite);
  assert.equal(checkouts.at(-1).currency, 'usd');
  await post('/api/billing/checkout', { item: 'credits_10' });
  assert.equal(checkouts.at(-1).productId, ids.credits_10);
  assert.equal((await post('/api/billing/checkout', { item: 'gold' })).status, 400);
  assert.equal((await post('/api/billing/checkout', { item: 'pro', interval: 'week' })).status, 400);
  user = { ...user, phone: '+447700900123' };
});

test('signed webhooks apply once; unsigned ones are refused; subscribers manage plans in the portal', async () => {
  const event = { type: 'subscription.active', data: { id: 'sub_r1', status: 'active', product_id: ids.pro_month,
    modified_at: '2026-10-04T10:00:00Z', customer: { external_id: user.id } } };
  const raw = JSON.stringify(event), ts = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac('sha256', signingKey).update(`wh_r1.${ts}.${raw}`).digest('base64')}`;
  const send = sig => fetch(`${base}/webhooks/polar`, { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'webhook-id': 'wh_r1', 'webhook-timestamp': ts, 'webhook-signature': sig } });
  assert.equal((await send('v1,AAAA')).status, 403);
  const first = await send(signature);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { outcome: 'applied' });
  assert.deepEqual(await (await send(signature)).json(), { outcome: 'duplicate' });
  user = (await db.query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
  assert.equal(user.tier, 'pro');
  const before = checkouts.length;
  assert.deepEqual(await (await post('/api/billing/checkout', { item: 'business', interval: 'month' })).json(),
    { kind: 'portal', url: 'https://polar.example/portal' });
  assert.equal(checkouts.length, before, 'no second subscription checkout');
});

test('the dialer quote says what a call will cost before it connects', async () => {
  const uk = await (await fetch(`${base}/api/billing/quote?to=${encodeURIComponent('+33612345678')}`)).json();
  assert.equal(uk.pays_with, 'plan');
  assert.equal(uk.surcharge_cents_per_min, 0);
  assert.equal(uk.plan_minutes_left, 300, 'a UK owner gets UK plan minutes');
  assert.equal(uk.overage_cents_per_min, 3 + 2 + 4, 'UK owner calling France: base, UK leg, EU leg');
  const et = await (await fetch(`${base}/api/billing/quote?to=${encodeURIComponent('+251911234567')}`)).json();
  assert.equal(et.pays_with, 'credits');
  assert.equal(et.surcharge_cents_per_min, 50);
  assert.equal(et.max_minutes, 0);
  assert.equal((await fetch(`${base}/api/billing/quote?to=${encodeURIComponent('+19005550100')}`)).status, 403);
});
