import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { trialPhoneHash } from '../lib/trial-tombstone.js';
import { numberQuarantineDays } from '../lib/number-quarantine.js';

process.env.AUDIT_SALT = 'test-trial-secret-at-least-32-characters';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.SKIP_TWILIO_SIGNATURE_CHECK = 'true';
process.env.TWILIO_AUTH_TOKEN = 'test-token';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
mock.module('./process-deletion.js', { namedExports: { processDeletion: async () => ({ status: 'confirmed' }) } });
const { deleteAccount } = await import('./delete-account.js');
const { releaseExpiredNumbers } = await import('./release-numbers.js');
const { expireOldCalls } = await import('./retention.js');
const { reserveCallInTransaction } = await import('../db/reserve-call.js');
const { claimNumberInTransaction } = await import('../db/claim-number.js');
const { findUserByAgentNumber, assignAgentNumber } = await import('../db/agent-numbers.js');
const { inboundRouter } = await import('../routes/inbound.js');
const app = express();
app.use(express.urlencoded({ extended: false }), inboundRouter);
const server = app.listen(0);
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const newUser = phone => one("INSERT INTO users(phone,terms_version) VALUES($1,'2026-10-07') RETURNING *", [phone]);
const voiceUrl = 'https://example.com/twiml/incoming';
const stock = phone => db.query('INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES($1,$1,$2)', [phone, voiceUrl]);
const claim = user => db.transaction(tx => claimNumberInTransaction(tx, user.id, voiceUrl));
const reserve = (user, key) => db.transaction(tx => reserveCallInTransaction(tx, user, '+12025550199', false, key));

test('the quarantine migration is safe to run twice and leaves fresh stock assignable', async () => {
  const owner = await newUser('+12025550101');
  await stock('+12025550201'); await stock('+12025550202');
  await db.query("UPDATE users SET agent_number='+12025550201' WHERE id=$1", [owner.id]);
  const sql = await readFile(new URL('../db/migrations/20261011_number_quarantine.sql', import.meta.url), 'utf8');
  await db.exec(sql); await db.exec(sql);
  // No blanket hold: new paying customers must still get a number on the day it ships.
  assert.equal((await one("SELECT available_after FROM agent_number_pool WHERE phone='+12025550202'")).available_after, null);
  assert.equal((await one("SELECT available_after FROM agent_number_pool WHERE phone='+12025550201'")).available_after, null);
  const trialSql = await readFile(new URL('../db/migrations/20261011_trial_tombstones.sql', import.meta.url), 'utf8');
  await db.exec(trialSql); await db.exec(trialSql);
  assert.equal((await one("SELECT relrowsecurity FROM pg_class WHERE relname='trial_tombstones'")).relrowsecurity, true);
});

test('expired subscriptions quarantine the only free number; inbound callers hear a neutral hangup', async () => {
  process.env.NUMBER_QUARANTINE_DAYS = '14';
  try {
    const owner = await newUser('+12025550102'), next = await newUser('+12025550103');
    await stock('+12025550203');
    await db.query("UPDATE users SET agent_number='+12025550203',number_release_at=now()-interval '1 day' WHERE id=$1", [owner.id]);
    const staleOwner = await findUserByAgentNumber('+12025550203');
    assert.deepEqual(await releaseExpiredNumbers(), { released: 1 });
    await assert.rejects(db.transaction(tx => reserveCallInTransaction(tx, staleOwner, '+12025550999', false, 'stale-inbound', { direction: 'inbound' })),
      { code: 'number_not_in_service' });
    const pooled = await one("SELECT available_after FROM agent_number_pool WHERE phone='+12025550203'");
    const days = (new Date(pooled.available_after) - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days <= 14);
    // Only the released number is left free, so the pool is empty during its quarantine.
    await db.query("UPDATE agent_number_pool SET available_after=now()+interval '1 day' WHERE phone <> '+12025550203' AND available_after IS NULL");
    await assert.rejects(claim(next), { code: 'number_pool_empty' });
    assert.equal(await assignAgentNumber(next.phone, '+12025550203'), undefined, 'operator helper also respects quarantine');
    assert.equal(await findUserByAgentNumber('+12025550203'), undefined);
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: '+12025550999', To: '+12025550203', CallSid: 'CA' + 'b'.repeat(32) }) });
    assert.equal(response.status, 200);
    const xml = await response.text();
    assert.match(xml, /<Say>This number is not in service\.<\/Say><Hangup\/>/);
    assert.doesNotMatch(xml, /<Dial|<Record|<Gather/);
    // Even an accidental manual assignment cannot route during quarantine.
    await db.query("UPDATE users SET agent_number='+12025550203' WHERE id=$1", [next.id]);
    assert.equal(await findUserByAgentNumber('+12025550203'), undefined);
    await db.query('UPDATE users SET agent_number=NULL WHERE id=$1', [next.id]);
    await db.query("UPDATE agent_number_pool SET available_after=now()-interval '1 second' WHERE phone='+12025550203'");
    assert.equal((await claim(next)).agent_number, '+12025550203');
    assert.equal((await findUserByAgentNumber('+12025550203')).id, next.id);
    assert.deepEqual(await releaseExpiredNumbers(), { released: 0 });
  } finally { delete process.env.NUMBER_QUARANTINE_DAYS; }
});

test('deletion retains only the HMAC and deletion-time trial marker; re-registration cannot restart a trial', async () => {
  const owner = await newUser('+12025550104');
  await stock('+12025550204');
  await db.query("UPDATE users SET agent_number='+12025550204' WHERE id=$1", [owner.id]);
  await reserve(owner, 'first');
  await assert.rejects(deleteAccount(owner.id), { status: 409 });
  assert.equal(await one('SELECT * FROM trial_tombstones WHERE phone_hash=$1', [trialPhoneHash(owner.phone)]), undefined);
  await db.query("UPDATE calls SET status='completed',duration_sec=60 WHERE user_id=$1", [owner.id]);
  await deleteAccount(owner.id);
  const fingerprint = createHmac('sha256', process.env.AUDIT_SALT).update(`trial-phone:${owner.phone}`).digest('hex');
  const marker = await one('SELECT * FROM trial_tombstones WHERE phone_hash=$1', [fingerprint]);
  assert.deepEqual(Object.keys(marker).sort(), ['phone_hash','trial_used_at']);
  assert.ok(Date.now() - new Date(marker.trial_used_at) < 60_000);
  const days = (new Date((await one("SELECT available_after FROM agent_number_pool WHERE phone='+12025550204'")).available_after) - Date.now()) / 86_400_000;
  assert.ok(days > 59.9 && days <= 60);
  await deleteAccount(owner.id);
  assert.deepEqual(await one('SELECT * FROM trial_tombstones WHERE phone_hash=$1', [fingerprint]), marker);
  await assert.rejects(reserve(owner, 'stale-account'), { code: 'account_not_found' });
  const fresh = await newUser(owner.phone);
  await assert.rejects(reserve(fresh, 'second-trial'), { code: 'trial_already_used' });
  assert.equal((await one('SELECT trial_ends_at FROM users WHERE id=$1', [fresh.id])).trial_ends_at, null);
  assert.equal((await one('SELECT count(*)::int AS n FROM calls WHERE user_id=$1', [fresh.id])).n, 0);
  // Deleting a rejected account must not reset the 12-month clock.
  await deleteAccount(fresh.id);
  assert.deepEqual(await one('SELECT * FROM trial_tombstones WHERE phone_hash=$1', [fingerprint]), marker);
  const paid = await newUser(owner.phone);
  await db.query("UPDATE users SET tier='pro' WHERE id=$1", [paid.id]);
  assert.equal((await reserve(paid, 'paid')).call.billing_tier, 'pro', 'even a stale free snapshot uses the current paid plan');
});

test('12-month expiry allows another trial and daily retention physically removes expired fingerprints', async () => {
  const owner = await newUser('+12025550105');
  await db.query("INSERT INTO trial_tombstones VALUES($1,now()-interval '12 months'+interval '1 minute')", [trialPhoneHash(owner.phone)]);
  await assert.rejects(reserve(owner, 'too-early'), { code: 'trial_already_used' });
  await db.query("UPDATE trial_tombstones SET trial_used_at=now()-interval '12 months'-interval '1 second' WHERE phone_hash=$1", [trialPhoneHash(owner.phone)]);
  assert.equal((await reserve(owner, 'expired')).call.billing_tier, 'trial');
  await expireOldCalls();
  assert.equal(await one('SELECT * FROM trial_tombstones WHERE phone_hash=$1', [trialPhoneHash(owner.phone)]), undefined);
  assert.ok(await one('SELECT * FROM trial_tombstones WHERE phone_hash=$1', [trialPhoneHash('+12025550104')]), 'unexpired fingerprints stay');
});

test('unused trials leave no tombstone; missing secret fails closed and rolls deletion back', async () => {
  const unused = await newUser('+12025550106');
  await deleteAccount(unused.id);
  assert.equal(await one('SELECT * FROM trial_tombstones WHERE phone_hash=$1', [trialPhoneHash(unused.phone)]), undefined);
  const used = await newUser('+12025550107');
  await db.query("UPDATE users SET trial_ends_at=now()-interval '1 day' WHERE id=$1", [used.id]);
  const fresh = await newUser('+12025550108');
  const salt = process.env.AUDIT_SALT;
  try {
    delete process.env.AUDIT_SALT;
    await assert.rejects(deleteAccount(used.id), /AUDIT_SALT/);
    await assert.rejects(reserve(fresh, 'no-secret'), /AUDIT_SALT/);
    assert.equal((await one('SELECT phone FROM users WHERE id=$1', [used.id])).phone, used.phone);
    assert.equal((await one('SELECT trial_ends_at FROM users WHERE id=$1', [fresh.id])).trial_ends_at, null);
  } finally { process.env.AUDIT_SALT = salt; }
});

test('quarantine configuration and fingerprint validation fail closed', () => {
  assert.equal(numberQuarantineDays(), 60);
  for (const value of ['0', '-1', '1.5', 'bad', '', '3651']) {
    process.env.NUMBER_QUARANTINE_DAYS = value;
    assert.throws(numberQuarantineDays, /NUMBER_QUARANTINE_DAYS/);
  }
  delete process.env.NUMBER_QUARANTINE_DAYS;
  assert.throws(() => trialPhoneHash('deleted:uuid'), /E.164/);
  assert.notEqual(trialPhoneHash('+12025550101'), trialPhoneHash('+12025550102'));
});

test('reservation rejects premium destinations and inbound forwarding to a premium handset', async () => {
  const owner = await newUser('+12025550109');
  await assert.rejects(db.transaction(tx => reserveCallInTransaction(tx, owner, '+43900123456', false, 'premium')),
    { code: 'destination_not_supported' });
  const premium = await newUser('+3531550123456');
  await assert.rejects(db.transaction(tx => reserveCallInTransaction(tx, premium, 'anonymous', false, 'forward', { direction: 'inbound' })),
    { code: 'handset_not_supported' });
  assert.equal((await one('SELECT count(*)::int AS n FROM calls WHERE user_id=ANY($1)', [[owner.id, premium.id]])).n, 0);
});
