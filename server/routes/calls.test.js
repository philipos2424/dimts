import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

process.env.PUBLIC_BASE_URL = 'https://calls.example.com';
process.env.TWILIO_NUMBER = '+15555550999';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const user = (await db.query("INSERT INTO users(phone,terms_version) VALUES('+15555550101','2026-10-21') RETURNING *")).rows[0];
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
mock.module('../lib/users.js', { namedExports: {
  resolveUser: async () => user, currentMonth: () => '2026-10',
  HttpError: class extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } },
} });
let providerCalls = 0;
let rejectPreflight = false;
let preflights = 0;
mock.module('../services/call-preflight.js', { namedExports: { checkCallDestination: async () => {
  preflights++;
  if (rejectPreflight) throw Object.assign(new Error('unverified destination'), { status: 403, code: 'destination_trial_number_required' });
} } });
let stops = 0;
mock.module('../services/end-call.js', { namedExports: { reconcileCall: async (_call, options) => {
  if (options?.stop) { stops++; return { ended: true }; }
  return { ended: false };
} } });
mock.module('../services/originate.js', { namedExports: {
  isE164: n => /^\+[1-9]\d{6,14}$/.test(n), fetchRecording: async () => {},
  originateCall: async () => { providerCalls++; return 'CA_TEST'; },
} });
let routeResult = { route: 'phone' };
let chooseCalls = [];
mock.module('../lib/app-call-route.js', { namedExports: { chooseRoute: async (...args) => { chooseCalls.push(args); return routeResult; } } });
let startAppCall = async () => { throw new Error('startAppCall not expected'); };
const started = [];
mock.module('../services/app-calls.js', { namedExports: { startAppCall: (...args) => { started.push(args); return startAppCall(...args); } } });
const sentry = [];
mock.module('../lib/sentry.js', { namedExports: { captureCallFailure: (...args) => { sentry.push(args); } } });
const { callsRouter } = await import('./calls.js');
const app = express(); app.use(express.json()); app.use('/calls', callsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || err.message }));
test.after(() => db.close());
async function post(key, destination = '+15555550102', extra = {}) {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/calls`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify({ destination, ...extra }),
    });
    return { status: response.status, data: await response.json() };
  } finally { server.close(); }
}
test('a retried HTTP request cannot originate twice; invalid requests never call Twilio', async () => {
  assert.equal((await post()).status, 400);
  assert.equal((await post('request-loop', user.phone)).status, 400);
  const first = await post('request-0001');
  const retry = await post('request-0001');
  assert.equal(first.status, 201); assert.equal(retry.status, 200);
  assert.equal(first.data.callId, retry.data.callId);
  assert.equal((await db.query('SELECT twilio_account_sid FROM calls WHERE id=$1', [first.data.callId])).rows[0].twilio_account_sid, process.env.TWILIO_ACCOUNT_SID);
  assert.equal(providerCalls, 1);
  assert.equal(preflights, 1, 'an idempotent retry skips preflight');
  assert.equal((await post('request-0002')).status, 409);
  assert.equal(providerCalls, 1);
});

test('unserved countries and premium numbers are refused before any reservation, preflight or provider call', async () => {
  const before = (await db.query('SELECT count(*)::int AS count FROM calls')).rows[0].count;
  const checks = preflights, dialled = providerCalls;
  for (const [key, destination] of [['request-nigeria', '+2348012345678'], ['request-jamaica', '+18765551234'], ['request-premium', '+19005551234']]) {
    const result = await post(key, destination);
    assert.equal(result.status, 403, destination);
    assert.equal(result.data.error, 'destination_not_supported');
  }
  assert.equal((await db.query('SELECT count(*)::int AS count FROM calls')).rows[0].count, before);
  assert.equal(preflights, checks);
  assert.equal(providerCalls, dialled);
});

test('unverified trial destinations create no call reservation or provider call', async () => {
  rejectPreflight = true;
  const before = (await db.query('SELECT count(*)::int AS count FROM calls')).rows[0].count;
  assert.equal((await post('request-unverified')).status, 403);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM calls')).rows[0].count, before);
  assert.equal(providerCalls, 1);
  rejectPreflight = false;
});

test('ending a call checks ownership before touching the provider', async () => {
  const server = app.listen(0);
  try {
    const other = (await db.query("INSERT INTO users(phone,terms_version) VALUES('+15555550103','2026-10-21') RETURNING id")).rows[0];
    const call = (await db.query("INSERT INTO calls(user_id,user_phone,destination) VALUES($1,'+15555550103','+15555550104') RETURNING id", [other.id])).rows[0];
    const url = `http://127.0.0.1:${server.address().port}/calls/`;
    assert.equal((await fetch(`${url}${call.id}/end`, { method: 'POST' })).status, 404);
    assert.equal(stops, 0);
    const own = (await db.query('SELECT id FROM calls WHERE user_id=$1 LIMIT 1', [user.id])).rows[0];
    assert.equal((await fetch(`${url}${own.id}/end`, { method: 'POST' })).status, 200);
    assert.equal(stops, 1);
  } finally { server.close(); }
});

const callee = (await db.query("INSERT INTO users(phone,terms_version) VALUES('+15555550177','2026-10-21') RETURNING *")).rows[0];
async function finishAll() { await db.query("UPDATE calls SET status='completed', budget_released=true WHERE user_id=$1", [user.id]); }
function appRoute() { routeResult = { route: 'app', callee }; startAppCall = async () => ({ appCallId: 'app-1', callId: 'call-1' }); }
function reset() { routeResult = { route: 'phone' }; startAppCall = async () => { throw new Error('startAppCall not expected'); }; chooseCalls = []; started.length = 0; sentry.length = 0; }

test('phone responses carry route phone, 201 and the 200 replay', async () => {
  reset(); await finishAll();
  const first = await post('route-phone-0001'), retry = await post('route-phone-0001');
  assert.equal(first.status, 201); assert.equal(first.data.route, 'phone');
  assert.equal(retry.status, 200); assert.equal(retry.data.route, 'phone');
  assert.equal(started.length, 0);
});

test('a qualifying callee starts an app call and never originates', async () => {
  reset(); await finishAll(); appRoute();
  const dialled = providerCalls, checks = preflights;
  const result = await post('route-app-0001', callee.phone);
  assert.equal(result.status, 201);
  assert.deepEqual(result.data, { callId: 'call-1', status: 'ringing', route: 'app', appCallId: 'app-1' });
  assert.equal(providerCalls, dialled); assert.equal(preflights, checks);
  assert.equal(started.length, 1); assert.equal(started[0][1], callee); assert.equal(started[0][2], 'route-app-0001');
});

test("route 'phone' in the body forces the phone path; unknown route is invalid_route; unrecorded stays phone", async () => {
  reset(); await finishAll(); appRoute();
  const bad = await post('route-bad-0001', callee.phone, { route: 'carrier' });
  assert.equal(bad.status, 400); assert.equal(bad.data.error, 'invalid_route');
  const dialled = providerCalls;
  const forced = await post('route-forced-0001', callee.phone, { route: 'phone' });
  assert.equal(forced.status, 201); assert.equal(forced.data.route, 'phone');
  assert.equal(providerCalls, dialled + 1); assert.equal(started.length, 0); assert.equal(chooseCalls.length, 0);
  await finishAll();
  const quiet = await post('route-quiet-0001', callee.phone, { record: false });
  assert.equal(quiet.data.route, 'phone'); assert.equal(chooseCalls.length, 0);
  await finishAll();
  const explicit = await post('route-explicit-0001', callee.phone, { route: 'app' });
  assert.equal(explicit.data.route, 'app'); assert.equal(chooseCalls.length, 1);
});

test('a retried app call replays 200 with the app call; another destination or forced phone is request_key_reused', async () => {
  reset(); await finishAll();
  const appCall = (await db.query('INSERT INTO app_calls(caller_id,callee_id) VALUES($1,$2) RETURNING id', [user.id, callee.id])).rows[0];
  const row = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,request_key,status,route,app_call_id,record_enabled)
    VALUES($1,$2,$3,'route-replay-0001','ringing','app',$4,true) RETURNING id`, [user.id, user.phone, callee.phone, appCall.id])).rows[0];
  const retry = await post('route-replay-0001', callee.phone);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, { callId: row.id, status: 'ringing', route: 'app', appCallId: appCall.id });
  assert.equal(started.length, 0); assert.equal(chooseCalls.length, 0);
  const other = await post('route-replay-0001', '+15555550188');
  assert.equal(other.status, 409); assert.equal(other.data.error, 'request_key_reused');
  const forced = await post('route-replay-0001', callee.phone, { route: 'phone' });
  assert.equal(forced.status, 409); assert.equal(forced.data.error, 'request_key_reused');
  await db.query("UPDATE calls SET status='completed' WHERE id=$1", [row.id]);
});

test('a failing app start falls back to the phone path; unexpected errors are reported', async () => {
  reset(); await finishAll(); appRoute();
  startAppCall = async () => { throw Object.assign(new Error('busy'), { status: 409, code: 'call_in_progress' }); };
  const dialled = providerCalls;
  const busy = await post('route-fallback-0001', callee.phone);
  assert.equal(busy.status, 201); assert.equal(busy.data.route, 'phone'); assert.equal(providerCalls, dialled + 1);
  await finishAll(); sentry.length = 0;
  startAppCall = async () => { throw new TypeError('boom'); };
  const broken = await post('route-fallback-0002', callee.phone);
  assert.equal(broken.status, 201); assert.equal(broken.data.route, 'phone'); assert.equal(providerCalls, dialled + 2);
  assert.equal(sentry.length, 1); assert.equal(sentry[0][1].stage, 'app_route'); assert.equal(sentry[0][1].userId, user.id);
});

test('a racing same-key retry replays the app call without phone fallback or Sentry', async () => {
  reset(); await finishAll(); appRoute();
  const appCall = (await db.query('INSERT INTO app_calls(caller_id,callee_id) VALUES($1,$2) RETURNING id', [user.id, callee.id])).rows[0];
  const dialled = providerCalls;
  startAppCall = async () => {
    const row = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,request_key,status,route,app_call_id,record_enabled)
      VALUES($1,$2,$3,'route-race-0001','ringing','app',$4,true) RETURNING id`, [user.id, user.phone, callee.phone, appCall.id])).rows[0];
    startAppCall.rowId = row.id;
    throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
  };
  const result = await post('route-race-0001', callee.phone);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { callId: startAppCall.rowId, status: 'ringing', route: 'app', appCallId: appCall.id });
  assert.equal(providerCalls, dialled); assert.equal(sentry.length, 0);
  await finishAll();
});

test('the phone idempotent replay reports the returned row route and app call', async () => {
  reset(); await finishAll();
  const appCall = (await db.query('INSERT INTO app_calls(caller_id,callee_id) VALUES($1,$2) RETURNING id', [user.id, callee.id])).rows[0];
  const row = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,request_key,status,route,app_call_id,record_enabled)
    VALUES($1,$2,$3,'route-label-0001','ringing','app',$4,true) RETURNING id`, [user.id, user.phone, callee.phone, appCall.id])).rows[0];
  // route 'app' rows are replayed by the app branch; the shared replay must agree with it.
  const result = await post('route-label-0001', callee.phone);
  assert.deepEqual(result.data, { callId: row.id, status: 'ringing', route: 'app', appCallId: appCall.id });
  await finishAll();
});

test('a failure after a successful app start never reaches the phone path', async () => {
  reset(); await finishAll(); appRoute();
  const dialled = providerCalls, before = (await db.query('SELECT count(*)::int AS n FROM calls')).rows[0].n;
  startAppCall = async () => ({ appCallId: undefined, callId: { toJSON() { throw new Error('serialize boom'); } } });
  const result = await post('route-after-0001', callee.phone);
  assert.equal(result.status, 500);
  assert.equal(providerCalls, dialled);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM calls')).rows[0].n, before);
  assert.equal(sentry.length, 0);
});
