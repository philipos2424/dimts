import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { TERMS_VERSION } from './terms.js';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
let failQueries = false;
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => (failQueries ? Promise.reject(new Error('db down')) : db.query(sql, p)),
  queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const { chooseRoute } = await import('./app-call-route.js');
test.after(() => db.close());

process.env.APP_CALLS_ENABLED = 'true';
delete process.env.APP_CALLS_BLOCKED_PREFIXES;
delete process.env.APP_CALLS_ALLOWLIST_USER_IDS;

let seq = 0;
const phone = () => `+1555555${String(1000 + ++seq).padStart(4, '0')}`;

/** A caller and callee for whom every condition holds; each test breaks exactly one. */
async function pair(callee = {}, caller = {}) {
  const make = async (over, findable) => {
    const o = { phone: phone(), terms: TERMS_VERSION, trial: "now() + interval '3 days'", ...over };
    return (await db.query(`INSERT INTO users(phone,terms_version,app_calls_findable,trial_ends_at)
      VALUES($1,$2,$3,${o.trial}) RETURNING *`, [o.phone, o.terms, findable])).rows[0];
  };
  const a = await make(caller, false), b = await make(callee, true);
  const hash = randomBytes(16).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hash, b.id]);
  await db.query('INSERT INTO notification_devices(user_id,session_hash,push_token,app_calls_supported) VALUES($1,$2,$3,true)',
    [b.id, hash, `ExponentPushToken[${hash}]`]);
  return { caller: a, callee: b, hash };
}
const route = async (p, destination = p.callee.phone) => (await chooseRoute(p.caller, destination)).route;

test('app route when every condition holds', async () => {
  const p = await pair();
  const result = await chooseRoute(p.caller, p.callee.phone);
  assert.equal(result.route, 'app');
  assert.equal(result.callee.id, p.callee.id);
});

test('phone when nobody owns the number', async () => {
  const p = await pair();
  assert.equal(await route(p, '+15555559999'), 'phone');
});

test('phone when the owner is deleted', async () => {
  const p = await pair();
  await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [p.callee.id]);
  assert.equal(await route(p), 'phone');
});

test('phone when the callee is not findable', async () => {
  const p = await pair();
  await db.query('UPDATE users SET app_calls_findable=false WHERE id=$1', [p.callee.id]);
  assert.equal(await route(p), 'phone');
});

test('phone when the callee has no enabled device', async () => {
  const p = await pair();
  await db.query('UPDATE notification_devices SET disabled=true WHERE user_id=$1', [p.callee.id]);
  assert.equal(await route(p), 'phone');
});

test('phone when the callee device does not support app calls', async () => {
  const p = await pair();
  await db.query('UPDATE notification_devices SET app_calls_supported=false WHERE user_id=$1', [p.callee.id]);
  assert.equal(await route(p), 'phone');
});

test('phone when the callee session has expired', async () => {
  const p = await pair();
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1", [p.hash]);
  assert.equal(await route(p), 'phone');
});

test('phone when the callee has not accepted the current terms', async () => {
  const p = await pair({ terms: '2020-01-01' });
  assert.equal(await route(p), 'phone');
});

test('phone when the caller has not accepted the current terms', async () => {
  const p = await pair({}, { terms: '2020-01-01' });
  assert.equal(await route(p), 'phone');
});

test('phone for a +251 callee, and for a +251 caller', async () => {
  const p = await pair({ phone: '+251911000001' });
  assert.equal(await route(p), 'phone');
  const q = await pair({}, { phone: '+251911000002' });
  assert.equal(await route(q), 'phone');
});

test('blocked prefixes come from APP_CALLS_BLOCKED_PREFIXES', async () => {
  const p = await pair();
  process.env.APP_CALLS_BLOCKED_PREFIXES = '1555';
  try { assert.equal(await route(p), 'phone'); } finally { delete process.env.APP_CALLS_BLOCKED_PREFIXES; }
  assert.equal(await route(p), 'app');
});

test('phone for a Gulf callee and for a Gulf caller (explicit consent)', async () => {
  const p = await pair({ phone: '+971500000001' });
  assert.equal(await route(p), 'phone');
  const q = await pair({}, { phone: '+971500000002' });
  assert.equal(await route(q), 'phone');
});

test('phone when the recording policy is not notice', async () => {
  const p = await pair({ phone: '+4915112345678' }); // Germany needs explicit consent
  assert.equal(await route(p), 'phone');
});

test('phone when the feature flag is off or unset', async () => {
  const p = await pair();
  process.env.APP_CALLS_ENABLED = 'false';
  try { assert.equal(await route(p), 'phone'); } finally { process.env.APP_CALLS_ENABLED = 'true'; }
  delete process.env.APP_CALLS_ENABLED;
  try { assert.equal(await route(p), 'phone', 'off by default'); } finally { process.env.APP_CALLS_ENABLED = 'true'; }
});

test('phone when the callee is out of minutes and credits', async () => {
  const p = await pair({ trial: 'NULL' });
  await db.query("UPDATE users SET tier='free', minutes_override=0 WHERE id=$1", [p.callee.id]);
  assert.equal(await route(p), 'phone');
  await db.query('UPDATE users SET minutes_override=10 WHERE id=$1', [p.callee.id]);
  assert.equal(await route(p), 'app');
});

test('credits alone let the callee take an app call', async () => {
  const p = await pair({ trial: 'NULL' });
  await db.query('UPDATE users SET minutes_override=0 WHERE id=$1', [p.callee.id]);
  assert.equal(await route(p), 'phone');
  await db.query("INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key) VALUES($1,500,'grant',$2)", [p.callee.id, `grant-${p.callee.id}`]);
  assert.equal(await route(p), 'app');
});

test('phone when the callee already has an active call', async () => {
  const p = await pair();
  const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,plan_seconds)
    VALUES($1,$2,'+15555550000','ringing',0) RETURNING id`, [p.callee.id, p.callee.phone])).rows[0];
  assert.equal(await route(p), 'phone');
  await db.query('UPDATE calls SET deleted_at=now() WHERE id=$1', [call.id]);
  assert.equal(await route(p), 'app', 'a deleted call does not count');
  await db.query("UPDATE calls SET deleted_at=NULL, status='completed' WHERE id=$1", [call.id]);
  assert.equal(await route(p), 'app', 'a finished call does not count');
});

test('phone when the callee is the caller', async () => {
  const p = await pair();
  assert.equal((await chooseRoute(p.callee, p.callee.phone)).route, 'phone');
});

test('allowlist: when set, both caller and callee must be listed', async () => {
  const p = await pair();
  try {
    process.env.APP_CALLS_ALLOWLIST_USER_IDS = `${p.caller.id}, ${p.callee.id}`;
    assert.equal(await route(p), 'app');
    process.env.APP_CALLS_ALLOWLIST_USER_IDS = p.callee.id;
    assert.equal(await route(p), 'phone', 'caller missing');
    process.env.APP_CALLS_ALLOWLIST_USER_IDS = p.caller.id;
    assert.equal(await route(p), 'phone', 'callee missing');
  } finally { delete process.env.APP_CALLS_ALLOWLIST_USER_IDS; }
});

test('a database error returns phone and never throws', async () => {
  const p = await pair();
  failQueries = true;
  try { assert.deepEqual(await chooseRoute(p.caller, p.callee.phone), { route: 'phone' }); } finally { failQueries = false; }
});

test('an empty APP_CALLS_BLOCKED_PREFIXES still blocks +251 for callee and caller', async () => {
  const p = await pair({ phone: '+251911000003' });
  const q = await pair({}, { phone: '+251911000004' });
  process.env.APP_CALLS_BLOCKED_PREFIXES = '';
  try {
    assert.equal(await route(p), 'phone');
    assert.equal(await route(q), 'phone');
  } finally { delete process.env.APP_CALLS_BLOCKED_PREFIXES; }
});
