import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { TERMS_VERSION } from '../lib/terms.js';

process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p),
  queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const { appCallsRouter } = await import('./app-calls.js');
const { startAppCall } = await import('../services/app-calls.js');
const app = express();
app.use(express.json());
app.use('/api/app-calls', appCallsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'internal_error' }));
const server = app.listen(0), base = `http://127.0.0.1:${server.address().port}`;

const realFetch = globalThis.fetch;
let pushes = [], cloudflare = [], cloudflareMode = 'ok';
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://exp.host/')) {
    const payload = JSON.parse(init.body); pushes.push(payload);
    return Response.json({ data: payload.map((_, i) => ({ status: 'ok', id: `ticket-${pushes.length}-${i}` })) });
  }
  if (String(url).startsWith('https://rtc.live.cloudflare.com/')) {
    cloudflare.push({ url: String(url), init });
    return cloudflareMode === 'ok'
      ? Response.json({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }] })
      : new Response('no', { status: 500 });
  }
  throw new Error(`No real requests allowed: ${url}`);
};
test.after(async () => { globalThis.fetch = realFetch; await new Promise(r => server.close(r)); await db.close(); });
process.env.APP_CALLS_ENABLED = 'true';
process.env.CLOUDFLARE_TURN_KEY_ID = 'key-id';
process.env.CLOUDFLARE_TURN_API_TOKEN = 'super-secret-api-token';

let seq = 0;
async function person(over = {}) {
  const token = randomBytes(32).toString('hex');
  const u = (await db.query(`INSERT INTO users(phone,terms_version,trial_ends_at) VALUES($1,$2,now()+interval '3 days') RETURNING *`,
    [`+1555555${String(3000 + ++seq).padStart(4, '0')}`, TERMS_VERSION])).rows[0];
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hash, u.id]);
  if (over.device) await db.query('INSERT INTO notification_devices(user_id,session_hash,push_token,app_calls_supported) VALUES($1,$2,$3,true)',
    [u.id, hash, `ExponentPushToken[${'x'.repeat(20)}${seq}]`]);
  return { ...u, token };
}
async function call(who, path, method = 'GET', body) {
  const response = await realFetch(`${base}/api/app-calls${path}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => null) };
}
async function fresh(over) {
  const [caller, callee, stranger] = [await person(), await person(over), await person()];
  const started = await startAppCall(caller, callee, `key-${randomBytes(6).toString('hex')}`);
  return { caller, callee, stranger, ...started };
}
const appRow = async id => (await db.query('SELECT * FROM app_calls WHERE id=$1', [id])).rows[0];
const callRow = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];

test('the whole surface is 404 until APP_CALLS_ENABLED is on', async () => {
  const c = await fresh();
  process.env.APP_CALLS_ENABLED = 'false';
  try {
    for (const [method, path] of [['GET', '/ice'], ['GET', '/incoming'], ['GET', `/${c.appCallId}`], ['GET', `/${c.appCallId}/signals`],
      ['POST', `/${c.appCallId}/signals`], ['POST', `/${c.appCallId}/answer`], ['POST', `/${c.appCallId}/decline`],
      ['POST', `/${c.appCallId}/connected`], ['POST', `/${c.appCallId}/end`]]) {
      assert.equal((await call(c.callee, path, method, {})).status, 404, `${method} ${path}`);
    }
  } finally { process.env.APP_CALLS_ENABLED = 'true'; }
  assert.equal((await call(c.callee, `/${c.appCallId}`)).status, 200);
});

test('signing in is required, and only the caller or callee can touch an app call', async () => {
  const c = await fresh();
  assert.equal((await call(null, `/${c.appCallId}`)).status, 401);
  const probes = [['GET', ''], ['GET', '/signals'], ['POST', '/signals', { kind: 'offer', payload: {} }], ['POST', '/answer'], ['POST', '/decline'],
    ['POST', '/connected', {}], ['POST', '/end', { seconds: 0 }]];
  for (const [method, suffix, body] of probes) {
    assert.equal((await call(c.stranger, `/${c.appCallId}${suffix}`, method, body ?? {})).status, 404, `${method} ${suffix}`);
    assert.equal((await call(c.stranger, `/not-a-uuid${suffix}`, method, body ?? {})).status, 404);
  }
  assert.equal((await appRow(c.appCallId)).status, 'ringing', 'the stranger changed nothing');
});

test('signals: only the other person sees them, ordered, bounded, validated and paged by cursor', async () => {
  const c = await fresh();
  const path = `/${c.appCallId}/signals`;
  assert.equal((await call(c.caller, path, 'POST', { kind: 'offer', payload: { sdp: 'v=0' } })).status, 201);
  await call(c.callee, path, 'POST', { kind: 'answer', payload: { sdp: 'a' } });
  for (let i = 0; i < 3; i++) await call(c.caller, path, 'POST', { kind: 'candidate', payload: { i } });
  const seen = (await call(c.callee, path)).data.signals;
  assert.deepEqual(seen.map(s => s.kind), ['offer', 'candidate', 'candidate', 'candidate']);
  assert.ok(seen.every((s, i) => i === 0 || s.id > seen[i - 1].id));
  assert.deepEqual((await call(c.caller, path)).data.signals.map(s => s.kind), ['answer'], 'a person never gets their own');
  const next = (await call(c.callee, `${path}?after=${seen[1].id}`)).data.signals;
  assert.deepEqual(next.map(s => s.id), [seen[2].id, seen[3].id]);
  for (const bad of ['abc', '-1', '1.5', '99999999999999999999', '']) {
    assert.equal((await call(c.callee, `${path}?after=${bad}`)).status, 400, `after=${bad}`);
  }
  for (const body of [{ kind: 'nope', payload: {} }, { kind: 'bye', payload: {} }, { kind: 'offer' }, { kind: 'offer', payload: [] }, { kind: 'offer', payload: 'x' }, { kind: 'offer', payload: null },
    { kind: 'offer', payload: { blob: 'x'.repeat(17000) } }, { payload: {} }]) {
    assert.equal((await call(c.caller, path, 'POST', body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await call(c.caller, path, 'POST', { kind: 'bye', payload: {} })).data.error, 'invalid_kind');
  assert.equal((await call(c.caller, path, 'POST', { kind: 'recording-stopped', payload: {} })).status, 201);
  for (let i = 0; i < 60; i++) await db.query("INSERT INTO app_call_signals(app_call_id,from_user,kind,payload) VALUES($1,$2,'candidate','{}')", [c.appCallId, c.caller.id]);
  assert.equal((await call(c.callee, path)).data.signals.length, 50, 'at most 50 per read');
});

test('signals are refused once the call is over and are rate limited per person', async () => {
  const c = await fresh();
  const path = `/${c.appCallId}/signals`;
  const window = Math.floor(Date.now() / 1000 / 600) * 600;
  const key = createHash('sha256').update(`app-signal:${c.caller.id}`).digest('hex');
  await db.query('INSERT INTO rate_limits(key,window_start,hits) VALUES($1,to_timestamp($2),600)', [key, window]);
  const limited = await call(c.caller, path, 'POST', { kind: 'offer', payload: {} });
  assert.equal(limited.status, 429);
  assert.equal((await call(c.callee, path, 'POST', { kind: 'answer', payload: {} })).status, 201, 'the other person is unaffected');
  await call(c.callee, `/${c.appCallId}/decline`, 'POST');
  assert.equal((await call(c.callee, path, 'POST', { kind: 'candidate', payload: {} })).status, 409);
  assert.equal((await call(c.caller, path)).status, 200, 'reading what was left is still allowed');
});

test('answer, connected and end drive the lifecycle and the statuses are monotonic', async () => {
  const c = await fresh();
  const id = c.appCallId;
  assert.equal((await call(c.caller, `/${id}/answer`, 'POST')).status, 403, 'the caller cannot answer');
  assert.equal((await call(c.caller, `/${id}/connected`, 'POST', {})).status, 409, 'not answered yet');
  assert.deepEqual((await call(c.callee, `/${id}`)).data, { status: 'ringing', role: 'callee', peerEnded: false });
  assert.equal((await call(c.callee, `/${id}/answer`, 'POST')).data.status, 'connecting');
  assert.equal((await call(c.callee, `/${id}/answer`, 'POST')).status, 409, 'answering twice');
  const rows = await appRow(id);
  assert.ok(rows.answered_at);
  assert.equal((await callRow(rows.caller_call_id)).status, 'in-progress');
  assert.equal((await callRow(rows.callee_call_id)).status, 'in-progress');
  assert.equal((await call(c.caller, `/${id}/connected`, 'POST', { fingerprintHash: 'abc' })).status, 200);
  assert.equal((await callRow(rows.callee_call_id)).other_party_notice_issued_at !== null, true, 'the caller reporting stamps the callee row');
  assert.equal((await callRow(rows.caller_call_id)).other_party_notice_issued_at, null);
  assert.equal((await call(c.callee, `/${id}/connected`, 'POST', {})).data.status, 'connected');
  assert.equal((await call(c.caller, `/${id}/connected`, 'POST', { fingerprintHash: 5 })).status, 400);
  assert.equal((await call(c.caller, `/${id}/end`, 'POST', { seconds: 'x' })).status, 400);
  assert.equal((await call(c.caller, `/${id}/end`, 'POST', { seconds: -1 })).status, 400);
  assert.equal((await call(c.caller, `/${id}/end`, 'POST', { seconds: 5 })).data.status, 'ended');
  assert.equal((await call(c.caller, `/${id}/end`, 'POST', { seconds: 5 })).data.status, 'ended', 'ending again is fine');
  assert.deepEqual((await call(c.callee, `/${id}`)).data, { status: 'ended', role: 'callee', peerEnded: true });
  assert.deepEqual((await call(c.caller, `/${id}`)).data, { status: 'ended', role: 'caller', peerEnded: false });
  assert.equal((await call(c.callee, `/${id}/answer`, 'POST')).status, 409);
  assert.equal((await call(c.caller, `/${id}/connected`, 'POST', {})).status, 409);
  const audits = (await db.query("SELECT action,target_id FROM audit_events WHERE target_id=$1 ORDER BY id", [id])).rows;
  assert.deepEqual(audits.map(a => a.action), ['app_call_started', 'app_call_ended']);
});

test('decline marks the call declined for both people', async () => {
  const c = await fresh();
  assert.equal((await call(c.caller, `/${c.appCallId}/decline`, 'POST')).status, 403);
  assert.equal((await call(c.callee, `/${c.appCallId}/decline`, 'POST')).data.status, 'declined');
  assert.equal((await call(c.caller, `/${c.appCallId}`)).data.status, 'declined');
  const app = await appRow(c.appCallId);
  assert.equal((await callRow(app.callee_call_id)).status, 'missed');
  assert.equal((await callRow(app.caller_call_id)).status, 'failed');
});

test('incoming shows the callee their ringing call, and a stale ring is expired on read', async () => {
  const c = await fresh();
  const incoming = (await call(c.callee, '/incoming')).data;
  assert.equal(incoming.appCall.appCallId, c.appCallId);
  assert.equal(incoming.appCall.from, c.caller.phone);
  assert.ok(incoming.appCall.callId);
  assert.deepEqual((await call(c.caller, '/incoming')).data, { appCall: null });
  assert.deepEqual((await call(c.stranger, '/incoming')).data, { appCall: null });
  await db.query("UPDATE app_calls SET created_at=now()-interval '50 seconds' WHERE id=$1", [c.appCallId]);
  assert.deepEqual((await call(c.callee, '/incoming')).data, { appCall: null });
  assert.equal((await call(c.caller, `/${c.appCallId}`)).data.status, 'missed', 'the caller sees the outcome');
});

test('the caller learns of a timeout when they read their status', async () => {
  const c = await fresh();
  await db.query("UPDATE app_calls SET created_at=now()-interval '50 seconds' WHERE id=$1", [c.appCallId]);
  assert.equal((await call(c.caller, `/${c.appCallId}`)).data.status, 'missed');
  assert.equal((await callRow((await appRow(c.appCallId)).caller_call_id)).error, 'No answer');
});

test('ice returns short-lived relay credentials to a person on a live call and never the API token', async () => {
  const c = await fresh();
  cloudflare = [];
  const ok = await call(c.caller, '/ice');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.iceServers[0].username, 'u');
  assert.ok(!JSON.stringify(ok.data).includes('super-secret-api-token'));
  assert.equal(cloudflare.length, 1);
  assert.equal((await call(c.stranger, '/ice')).status, 404, 'no live call, no credentials');
  cloudflareMode = 'fail';
  try {
    const down = await call(c.caller, '/ice');
    assert.equal(down.status, 503);
    assert.equal(down.data.error, 'turn_unavailable');
    assert.ok(!JSON.stringify(down.data).includes('super-secret-api-token'));
  } finally { cloudflareMode = 'ok'; }
  const saved = process.env.CLOUDFLARE_TURN_KEY_ID; delete process.env.CLOUDFLARE_TURN_KEY_ID;
  try { assert.equal((await call(c.caller, '/ice')).status, 503); } finally { process.env.CLOUDFLARE_TURN_KEY_ID = saved; }
});

test('starting an app call pushes the existing incoming-call alert with the app call id', async () => {
  pushes = [];
  const [caller, callee] = [await person(), await person({ device: true })];
  const started = await startAppCall(caller, callee, 'key-push-000001');
  const deadline = Date.now() + 3000;
  while (!pushes.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(pushes.length, 1);
  const calleeRow = (await db.query('SELECT id FROM calls WHERE app_call_id=$1 AND direction=$2', [started.appCallId, 'inbound'])).rows[0];
  assert.deepEqual(pushes[0][0].data, { type: 'incoming-call', callId: calleeRow.id, appCallId: started.appCallId });
  assert.ok(!JSON.stringify(pushes).includes(caller.phone), 'no caller details in the push');
});

test('heartbeat is for participants only, flag gated and rate limited per person', async () => {
  const c = await fresh();
  assert.equal((await call(c.stranger, `/${c.appCallId}/heartbeat`, 'POST', {})).status, 404);
  assert.equal((await call(c.callee, `/${c.appCallId}/answer`, 'POST')).status, 200);
  assert.equal((await call(c.callee, `/${c.appCallId}/heartbeat`, 'POST', {})).data.status, 'connecting');
  process.env.APP_CALLS_ENABLED = 'false';
  try { assert.equal((await call(c.callee, `/${c.appCallId}/heartbeat`, 'POST', {})).status, 404); } finally { process.env.APP_CALLS_ENABLED = 'true'; }
  const window = Math.floor(Date.now() / 1000 / 60) * 60;
  const key = createHash('sha256').update(`app-heartbeat:${c.caller.id}`).digest('hex');
  await db.query('INSERT INTO rate_limits(key,window_start,hits) VALUES($1,to_timestamp($2),30)', [key, window]);
  assert.equal((await call(c.caller, `/${c.appCallId}/heartbeat`, 'POST', {})).status, 429);
});
