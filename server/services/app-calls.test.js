import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { TERMS_VERSION } from '../lib/terms.js';

const account = 'AC' + 'a'.repeat(32);
process.env.TWILIO_ACCOUNT_SID = account;
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p),
  queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const svc = await import('./app-calls.js');
const { hasRecordingAuthorization } = await import('../lib/recording-policy.js');
test.after(() => db.close());

let seq = 0;
async function user(over = {}) {
  const phone = over.phone ?? `+1555555${String(2000 + ++seq).padStart(4, '0')}`;
  return (await db.query(`INSERT INTO users(phone,terms_version,trial_ends_at,minutes_override) VALUES($1,$2,now()+interval '3 days',$3) RETURNING *`,
    [phone, TERMS_VERSION, over.override ?? null])).rows[0];
}
const row = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];
const appRow = async id => (await db.query('SELECT * FROM app_calls WHERE id=$1', [id])).rows[0];
async function connect(a, b, key) {
  const started = await svc.startAppCall(a, b, key);
  await svc.answerAppCall(b, started.appCallId);
  await svc.reportConnected(a, started.appCallId);
  await svc.reportConnected(b, started.appCallId);
  return started;
}
const ago = (id, column, seconds) => db.query(`UPDATE app_calls SET ${column}=now()-make_interval(secs => $2) WHERE id=$1`, [id, seconds]);
const count = async table => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

test('starting creates two linked rows and one app_calls row with no carrier leg', async () => {
  const [a, b] = [await user(), await user()];
  const { appCallId, callId } = await svc.startAppCall(a, b, 'key-start-0001');
  const app = await appRow(appCallId);
  assert.equal(app.status, 'ringing');
  assert.equal(app.caller_id, a.id); assert.equal(app.callee_id, b.id);
  const caller = await row(app.caller_call_id), callee = await row(app.callee_call_id);
  assert.equal(callId, caller.id, 'callId is the caller row');
  assert.deepEqual([caller.direction, caller.route, caller.app_call_id, caller.user_id, caller.destination, caller.request_key, caller.record_enabled],
    ['outbound', 'app', appCallId, a.id, b.phone, 'key-start-0001', true]);
  assert.deepEqual([callee.direction, callee.route, callee.app_call_id, callee.user_id, callee.destination, callee.status, callee.record_enabled],
    ['inbound', 'app', appCallId, b.id, a.phone, 'ringing', true]);
  assert.equal(callee.request_key, `appcall-${appCallId}`);
  assert.equal(caller.twilio_call_sid, null); assert.equal(callee.twilio_call_sid, null);
  assert.equal(caller.consent_mode, 'notice');
  assert.ok(caller.parent_consent_at && !caller.child_consent_at && !caller.other_party_notice_issued_at);
  assert.ok(callee.child_consent_at && !callee.parent_consent_at && !callee.other_party_notice_issued_at);
});

test('retrying with the same key returns the same app call and creates nothing new', async () => {
  const [a, b] = [await user(), await user()];
  const first = await svc.startAppCall(a, b, 'key-retry-0001');
  const rows = await count('calls');
  assert.deepEqual(await svc.startAppCall(a, b, 'key-retry-0001'), first);
  assert.equal(await count('calls'), rows);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM app_calls WHERE caller_id=$1', [a.id])).rows[0].n, 1);
});

test('a busy caller or busy callee is 409 call_in_progress and the whole transaction rolls back', async () => {
  const [a, b, c] = [await user(), await user(), await user()];
  await svc.startAppCall(a, b, 'key-busy-0001');
  const [calls, apps] = [await count('calls'), await count('app_calls')];
  await assert.rejects(svc.startAppCall(a, c, 'key-busy-0002'), { status: 409, code: 'call_in_progress' });
  await assert.rejects(svc.startAppCall(c, b, 'key-busy-0003'), { status: 409, code: 'call_in_progress' });
  assert.equal(await count('calls'), calls, 'the free party got no orphan row');
  assert.equal(await count('app_calls'), apps);
});

test('a budget failure rolls back and propagates for the phone fallback', async () => {
  const [a, b] = [await user({ override: 0 }), await user()];
  const [calls, apps] = [await count('calls'), await count('app_calls')];
  await assert.rejects(svc.startAppCall(a, b, 'key-budget-001'), e => [402, 429].includes(e.status));
  assert.equal(await count('calls'), calls);
  assert.equal(await count('app_calls'), apps);
});

test('neither person is ever surcharged, even when the callee number is a surcharge country', async () => {
  const [a, b] = [await user(), await user({ phone: '+251911000123' })];
  const { appCallId } = await svc.startAppCall(a, b, 'key-surcharge1');
  const app = await appRow(appCallId);
  assert.equal((await row(app.caller_call_id)).surcharge_cents, 0);
  assert.equal((await row(app.callee_call_id)).surcharge_cents, 0);
});

test('recording is authorised for a person only after their peer reports the notice', async () => {
  const [a, b] = [await user(), await user()];
  const { appCallId } = await svc.startAppCall(a, b, 'key-consent-01');
  await svc.answerAppCall(b, appCallId);
  const get = async who => { const app = await appRow(appCallId); return row(who === 'caller' ? app.caller_call_id : app.callee_call_id); };
  assert.equal(hasRecordingAuthorization(await get('caller')), false);
  assert.equal(hasRecordingAuthorization(await get('callee')), false);
  await svc.reportConnected(a, appCallId); // the caller's client showed its notice
  assert.equal(hasRecordingAuthorization(await get('callee')), true, 'the callee row is authorised once the caller reported');
  assert.equal(hasRecordingAuthorization(await get('caller')), false, 'the caller row still waits for the callee');
  assert.equal((await appRow(appCallId)).status, 'connecting');
  await svc.reportConnected(a, appCallId); // idempotent
  await svc.reportConnected(b, appCallId);
  assert.equal(hasRecordingAuthorization(await get('caller')), true);
  assert.equal((await appRow(appCallId)).status, 'connected');
  const stamp = (await get('caller')).other_party_notice_issued_at;
  await svc.reportConnected(b, appCallId);
  assert.deepEqual((await get('caller')).other_party_notice_issued_at, stamp, 'a repeat does not move the timestamp');
});

test('ringing for more than 45 seconds becomes missed for the callee and failed with No answer for the caller', async () => {
  const [a, b] = [await user(), await user()];
  const { appCallId } = await svc.startAppCall(a, b, 'key-expire-001');
  await svc.expireRingingAppCalls(a.id);
  assert.equal((await appRow(appCallId)).status, 'ringing', 'not yet');
  await db.query("UPDATE app_calls SET created_at=now()-interval '50 seconds' WHERE id=$1", [appCallId]);
  await svc.expireRingingAppCalls(b.id);
  const app = await appRow(appCallId);
  assert.equal(app.status, 'missed');
  const caller = await row(app.caller_call_id), callee = await row(app.callee_call_id);
  assert.deepEqual([callee.status, callee.duration_sec], ['missed', 0]);
  assert.deepEqual([caller.status, caller.error, caller.duration_sec], ['failed', 'No answer', 0]);
  await assert.rejects(svc.answerAppCall(b, appCallId), { status: 409 });
  assert.equal((await appRow(appCallId)).status, 'missed', 'monotonic');
});

test('end twice finishes once: one usage addition and one ledger charge per person', async () => {
  const [a, b] = [await user({ override: 0 }), await user({ override: 0 })];
  for (const u of [a, b]) await db.query("INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key) VALUES($1,5000,'grant',$2)", [u.id, `topup-${u.id}`]);
  const { appCallId } = await connect(a, b, 'key-end-twice-1');
  assert.ok((await appRow(appCallId)).connected_at);
  await ago(appCallId, 'connected_at', 90);
  await svc.endAppCall(a, appCallId, 75);
  await svc.endAppCall(a, appCallId, 75);
  await svc.endAppCall(b, appCallId, 80);
  const app = await appRow(appCallId);
  assert.equal(app.status, 'ended');
  for (const u of [a, b]) {
    const usage = await db.query('SELECT minutes_used::float8 AS m FROM usage_minutes WHERE user_id=$1', [u.id]);
    assert.equal(usage.rows.length, 1);
    assert.equal(usage.rows[0].m, 75 / 60);
    const ledger = await db.query("SELECT amount_cents FROM credit_ledger WHERE user_id=$1 AND reason='call'", [u.id]);
    assert.equal(ledger.rows.length, 1);
    assert.ok(ledger.rows[0].amount_cents < 0);
  }
  assert.equal((await row(app.caller_call_id)).duration_sec, 75);
  assert.equal((await row(app.callee_call_id)).duration_sec, 75);
});

test('reported seconds are capped by what the server measured and never billed if never connected', async () => {
  const [a, b] = [await user(), await user()];
  const one = await connect(a, b, 'key-cap-000001');
  await svc.endAppCall(a, one.appCallId, 3600);
  const capped = await row((await appRow(one.appCallId)).caller_call_id);
  assert.ok(capped.duration_sec <= 2, `measured seconds win, got ${capped.duration_sec}`);
  const two = await svc.startAppCall(a, b, 'key-cap-000002');
  await svc.endAppCall(a, two.appCallId, 500); // cancelled while ringing
  const app = await appRow(two.appCallId);
  assert.equal(app.status, 'ended');
  const [caller, callee] = [await row(app.caller_call_id), await row(app.callee_call_id)];
  assert.deepEqual([caller.duration_sec, callee.duration_sec, caller.status, callee.status], [0, 0, 'failed', 'missed']);
});

test('an ended call can never go back', async () => {
  const [a, b] = [await user(), await user()];
  const { appCallId } = await svc.startAppCall(a, b, 'key-mono-00001');
  await svc.answerAppCall(b, appCallId);
  await svc.endAppCall(b, appCallId, 0);
  await assert.rejects(svc.answerAppCall(b, appCallId), { status: 409 });
  await assert.rejects(svc.reportConnected(a, appCallId), { status: 409 });
  await assert.rejects(svc.declineAppCall(b, appCallId), { status: 409 });
  assert.equal((await appRow(appCallId)).status, 'ended');
});

test('an answered call that never connected bills nothing, however long the client reports', async () => {
  const [a, b] = [await user({ override: 0 }), await user({ override: 0 })];
  for (const u of [a, b]) await db.query("INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key) VALUES($1,5000,'grant',$2)", [u.id, `topup-${u.id}`]);
  const { appCallId } = await svc.startAppCall(a, b, 'key-noconnect-1');
  await svc.answerAppCall(b, appCallId); // ICE failed: nobody ever reported the notice
  await ago(appCallId, 'answered_at', 30);
  await svc.endAppCall(a, appCallId, 120);
  const app = await appRow(appCallId);
  assert.equal(app.status, 'ended');
  assert.equal(app.connected_at, null);
  for (const u of [a, b]) {
    assert.equal((await db.query('SELECT count(*)::int AS n FROM usage_minutes WHERE user_id=$1', [u.id])).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM credit_ledger WHERE user_id=$1 AND reason='call'", [u.id])).rows[0].n, 0);
  }
  assert.equal((await row(app.caller_call_id)).duration_sec, 0);
});

test('a connected call, ended once, bills one ledger entry and one usage row per person', async () => {
  const [a, b] = [await user({ override: 0 }), await user({ override: 0 })];
  for (const u of [a, b]) await db.query("INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key) VALUES($1,5000,'grant',$2)", [u.id, `topup-${u.id}`]);
  const { appCallId } = await connect(a, b, 'key-connected-1');
  await ago(appCallId, 'connected_at', 100);
  await svc.endAppCall(a, appCallId, 120); // reported more than measured: capped at about 100
  for (const u of [a, b]) {
    assert.equal((await db.query("SELECT count(*)::int AS n FROM credit_ledger WHERE user_id=$1 AND reason='call'", [u.id])).rows[0].n, 1);
    const used = (await db.query('SELECT minutes_used::float8 AS m FROM usage_minutes WHERE user_id=$1', [u.id])).rows;
    assert.equal(used.length, 1);
    assert.ok(used[0].m * 60 >= 99 && used[0].m * 60 <= 102, `capped by measured time, got ${used[0].m * 60}`);
  }
});

test('stuck calls are swept and free both people to start a new call', async () => {
  const make = async () => [await user(), await user()];
  // Starting again would be 409 call_in_progress if either row were still active.
  const again = (a, b, key) => svc.startAppCall(a, b, key);
  // (a) answered but never connected for more than 60 s: failed, nothing billed
  let [a, b] = await make();
  let c = await svc.startAppCall(a, b, 'key-sweep-a-001');
  await svc.answerAppCall(b, c.appCallId);
  await svc.expireRingingAppCalls(a.id);
  assert.equal((await appRow(c.appCallId)).status, 'connecting', 'not yet');
  await ago(c.appCallId, 'answered_at', 70);
  await again(a, b, 'key-sweep-a-002');
  let app = await appRow(c.appCallId);
  assert.equal(app.status, 'failed');
  assert.deepEqual([(await row(app.caller_call_id)).duration_sec, (await row(app.callee_call_id)).duration_sec], [0, 0]);
  // (b) connected but not heard from for more than 90 s: ended at last_seen minus connected
  [a, b] = await make();
  c = await connect(a, b, 'key-sweep-b-001');
  await ago(c.appCallId, 'connected_at', 200);
  await ago(c.appCallId, 'last_seen_at', 120);
  await again(a, b, 'key-sweep-b-002');
  app = await appRow(c.appCallId);
  assert.equal(app.status, 'ended');
  const dur = (await row(app.caller_call_id)).duration_sec;
  assert.ok(dur >= 79 && dur <= 81, `last seen minus connected is 80 s, got ${dur}`);
  assert.equal((await row(app.callee_call_id)).duration_sec, dur);
  // (c) past max_duration_sec plus the grace, even while heartbeating
  [a, b] = await make();
  c = await connect(a, b, 'key-sweep-c-001');
  await db.query('UPDATE calls SET max_duration_sec=60 WHERE app_call_id=$1', [c.appCallId]);
  await ago(c.appCallId, 'connected_at', 200);
  await svc.heartbeat(a, c.appCallId);
  await again(a, b, 'key-sweep-c-002');
  app = await appRow(c.appCallId);
  assert.equal(app.status, 'ended');
  assert.equal((await row(app.caller_call_id)).duration_sec, 60, 'never more than max_duration_sec');
});

test('a heartbeating call is not swept, and an ended call is not revived by one', async () => {
  const [a, b] = [await user(), await user()];
  const c = await connect(a, b, 'key-heartbeat-01');
  await ago(c.appCallId, 'connected_at', 200);
  await ago(c.appCallId, 'last_seen_at', 100);
  await svc.heartbeat(b, c.appCallId);
  await svc.expireRingingAppCalls(a.id);
  assert.equal((await appRow(c.appCallId)).status, 'connected');
  await svc.endAppCall(a, c.appCallId, 5);
  const before = (await appRow(c.appCallId)).last_seen_at;
  await svc.heartbeat(b, c.appCallId);
  assert.deepEqual((await appRow(c.appCallId)).last_seen_at, before);
});

test('terminal calls drop their signals after ten minutes and a call holds at most 500', async () => {
  const [a, b] = [await user(), await user()];
  const c = await svc.startAppCall(a, b, 'key-signals-001');
  await db.query("INSERT INTO app_call_signals(app_call_id,from_user,kind) SELECT $1,$2,'candidate' FROM generate_series(1,500)", [c.appCallId, a.id]);
  await assert.rejects(svc.addSignal(a, c.appCallId, 'candidate', {}), { status: 429, code: 'too_many_signals' });
  await svc.endAppCall(a, c.appCallId, 0);
  await svc.expireRingingAppCalls(a.id);
  assert.ok((await count('app_call_signals')) >= 500, 'kept for a while after the end');
  await ago(c.appCallId, 'ended_at', 11 * 60);
  await svc.expireRingingAppCalls(b.id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM app_call_signals WHERE app_call_id=$1', [c.appCallId])).rows[0].n, 0);
});

test('a callee who cannot be recorded under the notice rule is refused and nothing is left behind', async () => {
  const [calls, apps] = [await count('calls'), await count('app_calls')];
  const noTerms = (await db.query("INSERT INTO users(phone,trial_ends_at) VALUES('+15555559901',now()+interval '3 days') RETURNING *")).rows[0];
  await assert.rejects(svc.startAppCall(await user(), noTerms, 'key-consent-fail1'), { status: 409, code: 'app_call_unavailable' });
  const gulf = await user({ phone: '+971500000777' }); // both people must press 1 there: not a notice call
  await assert.rejects(svc.startAppCall(await user(), gulf, 'key-consent-fail2'), { status: 409, code: 'app_call_unavailable' });
  assert.equal(await count('calls'), calls);
  assert.equal(await count('app_calls'), apps);
});
