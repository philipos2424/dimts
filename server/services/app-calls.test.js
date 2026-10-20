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
  const [a, b] = [await user(), await user({ phone: '+971500000123' })];
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
  const { appCallId } = await svc.startAppCall(a, b, 'key-end-twice-1');
  await svc.answerAppCall(b, appCallId);
  await db.query("UPDATE app_calls SET answered_at=now()-interval '90 seconds' WHERE id=$1", [appCallId]);
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
  const one = await svc.startAppCall(a, b, 'key-cap-000001');
  await svc.answerAppCall(b, one.appCallId);
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
