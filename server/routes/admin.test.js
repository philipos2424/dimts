import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
const hashToken = token => createHash('sha256').update(token).digest('hex');
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
process.env.ADMIN_PHONES = '+15555550100, not-a-number';
const { createApp } = await import('../create-app.js');
const { expireAuditEvents } = await import('../services/retention.js');
const { maskPhone, regionOf } = await import('../lib/admin.js');
const { monthlyListCents } = await import('../services/admin-metrics.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

async function signedIn(phone, { sessionAge = '1 minute' } = {}) {
  const user = (await db.query(`INSERT INTO users(phone) VALUES($1) ON CONFLICT (phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id`, [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,now()+interval '1 day',now()-$3::interval)`,
    [hashToken(token), user.id, sessionAge]);
  return { id: user.id, token };
}
async function api(path, token, { method = 'GET', body } = {}) {
  const response = await fetch(origin + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: text.startsWith('{') ? JSON.parse(text) : text, headers: response.headers };
}
const SECRET_WORDS = 'the confidential price is forty thousand';
async function customerWithCall(phone, { transcript = `dmt1.k1.calls:transcript.x.y.${randomBytes(4).toString('hex')}`, consent = true } = {}) {
  const user = (await db.query('INSERT INTO users(phone, tier) VALUES($1, $2) RETURNING id', [phone, 'pro'])).rows[0];
  const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,duration_sec,transcript,summary,record_enabled,consent_mode,
      other_party_notice_issued_at,parent_consent_at,recording_sid,audio_object_key,direction)
    VALUES($1,$2,'+15555559999','ready',125,$3,'dmt1.sealed',true,'notice',$4,now(),'RE1','obj','outbound') RETURNING id`,
  [user.id, phone, transcript, consent ? new Date() : null])).rows[0];
  return { id: user.id, callId: call.id };
}

test('the console is invisible to everyone but allowlisted staff with a recent sign-in', async () => {
  assert.equal((await api('/api/admin/overview')).status, 404);
  const customer = await signedIn('+15555550101');
  assert.equal((await api('/api/admin/overview', customer.token)).status, 404, 'a customer sees the same 404 as a missing route');
  const stale = await signedIn('+15555550100', { sessionAge: '13 hours' });
  const refused = await api('/api/admin/overview', stale.token);
  assert.equal(refused.status, 403); assert.equal(refused.body.error, 'reauth_required');
  const staff = await signedIn('+15555550100');
  assert.equal((await api('/api/admin/overview', staff.token)).status, 200);
});

test('measurements never carry call content or full phone numbers, and every view is audited', async () => {
  const staff = await signedIn('+15555550100');
  const a = await customerWithCall('+447700900123', { transcript: SECRET_WORDS });
  await db.query(`INSERT INTO subscriptions(id,user_id,product_key,plan,billing_interval,status) VALUES
    ('sub_a',$1,'pro_month','pro','month','active')`, [a.id]);
  await db.query(`INSERT INTO payments(order_id,user_id,product_key,currency,total_amount,tax_amount) VALUES ('ord_1',$1,'pro_month','usd',1900,0)`, [a.id]);
  const { status, body, text } = await api('/api/admin/overview', staff.token);
  assert.equal(status, 200);
  assert.ok(!text.includes('confidential') && !text.includes('+447700900123') && !text.includes('+15555559999'));
  assert.ok(body.accounts.total >= 1); assert.ok(body.accounts.by_region.UK >= 1);
  assert.equal(body.revenue.mrr_usd_cents, 1900); assert.equal(body.revenue.paying_users, 1);
  assert.ok(body.calls_30d.connected >= 1); assert.equal(body.signups_daily.length, 90); assert.equal(body.calls_daily.length, 30);
  assert.equal(body.top_accounts.find(row => row.id === a.id).phone, '+44 ••• 0123');
  const logged = (await db.query("SELECT count(*)::int n FROM audit_events WHERE user_id=$1 AND action='admin_viewed_overview'", [staff.id])).rows[0].n;
  assert.ok(logged >= 1);
  const cohorts = await api('/api/admin/cohorts', staff.token);
  assert.equal(cohorts.status, 200); assert.ok(Array.isArray(cohorts.body.cohorts));
});

test('search takes an exact number, the last four digits or an account ID, never a partial number', async () => {
  const staff = await signedIn('+15555550100');
  const target = await customerWithCall('+15555554321');
  const byLast4 = await api('/api/admin/customers?q=4321', staff.token);
  assert.deepEqual(byLast4.body.customers.map(row => row.id), [target.id]);
  assert.equal(byLast4.body.customers[0].phone, '+1 ••• 4321');
  assert.ok(!byLast4.text.includes('+15555554321'));
  assert.deepEqual((await api(`/api/admin/customers?q=${encodeURIComponent('+1 (555) 555-4321')}`, staff.token)).body.customers.map(r => r.id), [target.id]);
  assert.deepEqual((await api(`/api/admin/customers?q=${target.id.slice(0, 8)}`, staff.token)).body.customers.map(r => r.id), [target.id]);
  assert.deepEqual((await api('/api/admin/customers?q=555555', staff.token)).body.customers.map(r => r.id).filter(id => id === target.id), [],
    'six digits is neither a full number nor a last-four match');
  assert.deepEqual((await api('/api/admin/customers?q=%2B1555', staff.token)).body.customers, []);
});

test('opening an account needs a reason, and the customer sees it in their activity log', async () => {
  const staff = await signedIn('+15555550100');
  const customer = await customerWithCall('+15555550777', { transcript: SECRET_WORDS });
  assert.equal((await api(`/api/admin/customers/${customer.id}`, staff.token)).status, 400);
  const detail = await api(`/api/admin/customers/${customer.id}?reason=support_request`, staff.token);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.phone, '+1 ••• 0777');
  assert.ok(!detail.text.includes('confidential') && !detail.text.includes('+15555559999') && !detail.text.includes('+15555550777'));
  assert.equal(detail.body.usage_by_month[0].minutes, 2);
  const theirs = (await db.query("SELECT action, reason FROM audit_events WHERE user_id=$1", [customer.id])).rows;
  assert.deepEqual(theirs, [{ action: 'staff_viewed_account', reason: 'support_request' }]);
  const ours = (await db.query("SELECT target_id, reason FROM audit_events WHERE user_id=$1 AND action='admin_viewed_customer'", [staff.id])).rows;
  assert.deepEqual(ours, [{ target_id: customer.id, reason: 'support_request' }]);
  assert.equal((await api('/api/admin/customers/not-a-uuid?reason=support_request', staff.token)).status, 404);
});

test('revealing a number and granting credits are reasoned, capped and on both records', async () => {
  const staff = await signedIn('+15555550100');
  const customer = await customerWithCall('+15555550888');
  assert.equal((await api(`/api/admin/customers/${customer.id}/reveal-phone`, staff.token, { method: 'POST', body: {} })).status, 400);
  const revealed = await api(`/api/admin/customers/${customer.id}/reveal-phone`, staff.token, { method: 'POST', body: { reason: 'billing_issue' } });
  assert.deepEqual(revealed.body, { phone: '+15555550888' });
  assert.equal((await api(`/api/admin/customers/${customer.id}/credits`, staff.token, { method: 'POST', body: { reason: 'billing_issue', credits: 999999 } })).status, 400);
  const granted = await api(`/api/admin/customers/${customer.id}/credits`, staff.token, { method: 'POST', body: { reason: 'billing_issue', credits: 500 } });
  assert.deepEqual(granted.body, { balance: 500 });
  const theirs = (await db.query('SELECT action FROM audit_events WHERE user_id=$1 ORDER BY id', [customer.id])).rows.map(r => r.action);
  assert.deepEqual(theirs, ['staff_viewed_phone', 'credits_granted']);
  const log = await api('/api/admin/access-log', staff.token);
  assert.ok(log.body.events.some(e => e.action === 'admin_revealed_phone' && e.reason === 'billing_issue' && e.staff === '+1 ••• 0100'));
});

test('compliance flags unconsented recordings, plaintext content and overdue deletion requests', async () => {
  const staff = await signedIn('+15555550100');
  const before = Object.fromEntries((await api('/api/admin/compliance', staff.token)).body.checks.map(c => [c.id, c.count]));
  await customerWithCall('+15555550901', { consent: false });
  await customerWithCall('+15555550902', { transcript: 'plain words' });
  const owner = await customerWithCall('+15555550903');
  const request = (await db.query("INSERT INTO privacy_requests(phone_hash,created_at) VALUES('h',now()-interval '31 days') RETURNING id")).rows[0];
  await db.query('INSERT INTO privacy_request_targets(request_id,user_id) VALUES($1,$2)', [request.id, owner.id]);
  const after = (await api('/api/admin/compliance', staff.token)).body.checks;
  const byId = Object.fromEntries(after.map(c => [c.id, c]));
  assert.equal(byId.recording_authorization.count - before.recording_authorization, 1);
  assert.equal(byId.recording_authorization.status, 'fail');
  assert.equal(byId.encryption.count - before.encryption, 1);
  assert.equal(byId.privacy_overdue.count - before.privacy_overdue, 1);
  assert.ok(byId.privacy_overdue.source.includes('GDPR'));
});

test('activity-log entries older than a year are deleted by the daily job', async () => {
  await db.query(`INSERT INTO audit_events(action,created_at) VALUES('old_one',now()-interval '13 months'),('recent_one',now())`);
  assert.ok(await expireAuditEvents() >= 1);
  const left = (await db.query("SELECT action FROM audit_events WHERE action IN ('old_one','recent_one')")).rows.map(r => r.action);
  assert.deepEqual(left, ['recent_one']);
});

test('the console page is served without data, unindexed, under a strict CSP', async () => {
  const page = await fetch(origin + '/admin/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(await page.text(), /<script src="\/admin\/admin\.js"/);
  assert.equal((await fetch(origin + '/admin', { redirect: 'manual' })).status, 308);
  assert.equal((await fetch(origin + '/admin/admin.js')).status, 200);
});

test('masking, regions and list prices', () => {
  assert.equal(maskPhone('+971501234567'), '+971 ••• 4567');
  assert.equal(maskPhone('deleted:abc'), 'deleted');
  assert.equal(regionOf('+4915112345678'), 'EU/EEA');
  assert.equal(regionOf('+251911234567'), 'Ethiopia');
  assert.equal(regionOf('+966501234567'), 'Gulf');
  assert.equal(monthlyListCents('pro_year'), 1583);
  assert.equal(monthlyListCents('business_month_lite'), 1900);
  assert.equal(monthlyListCents('credits_10'), 0);
});
