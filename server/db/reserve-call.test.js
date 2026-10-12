import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { reserveCallInTransaction } from './reserve-call.js';
const account = 'AC' + 'a'.repeat(32);
process.env.TWILIO_ACCOUNT_SID = account;

test('call reservations enforce idempotency, concurrency and minute budgets using real SQL', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const owner = (await db.query("INSERT INTO users(phone,terms_version) VALUES('+15555550101','2026-10-07') RETURNING *")).rows[0];
    const reserve = async (key, dest = '+15555550102', record = true) => {
      const fresh = (await db.query('SELECT * FROM users WHERE id=$1', [owner.id])).rows[0];
      return db.transaction(tx => reserveCallInTransaction(tx, fresh, dest, record, key));
    };
    process.env.TWILIO_ACCOUNT_SID = 'invalid';
    await assert.rejects(reserve('invalid-account'), /Invalid TWILIO_ACCOUNT_SID/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM calls')).rows[0].n, 0);
    process.env.TWILIO_ACCOUNT_SID = account;
    const pair = await Promise.all([reserve('request-one'), reserve('request-one')]);
    assert.equal(pair[0].call.id, pair[1].call.id);
    assert.equal(pair.filter(r => r.created).length, 1);
    assert.equal(pair[0].call.max_duration_sec, 300, 'trial: 5 minutes');
    assert.equal(pair[0].call.twilio_account_sid, account);
    process.env.TWILIO_ACCOUNT_SID = 'AC' + 'd'.repeat(32);
    assert.equal((await reserve('request-one')).call.twilio_account_sid, account, 'retry retains original account');
    await assert.rejects(reserve('request-one', '+15555550103'), { code: 'request_key_reused' });
    await assert.rejects(reserve('request-one', '+15555550102', false), { code: 'request_key_reused' });
    await assert.rejects(reserve('request-two'), { code: 'call_in_progress' });
    assert.equal(pair[0].call.plan_seconds, 300, 'trial: 5 minutes');
    // A finished call counts what it lasted, not what it reserved.
    await db.query("UPDATE calls SET status='completed',duration_sec=240,plan_seconds=240 WHERE id=$1", [pair[0].call.id]);
    const second = await reserve('request-two');
    assert.equal(second.call.max_duration_sec, 120, 'a trial call that starts with a minute left may run on: 2-minute grace');
    assert.equal(second.call.overage_cents > 0 && second.call.plan_seconds < 120, false, 'the grace is never charged to the owner');
    await db.query("UPDATE calls SET status='failed' WHERE id=$1", [second.call.id]);
    await assert.rejects(reserve('request-three'), { code: 'credits_required', status: 402 });
    await db.query('UPDATE calls SET budget_released=true WHERE id=$1', [second.call.id]);
    process.env.CALLS_PER_DAY = '2';
    await assert.rejects(reserve('request-three'), { code: 'daily_call_limit' });
    process.env.CALLS_PER_DAY = '10';
    process.env.GLOBAL_CALL_MINUTES_PER_MONTH = '1';
    await assert.rejects(reserve('request-three'), { code: 'call_minutes_limit' });
    // Idempotency lookup still works after a budget is exhausted.
    assert.equal((await reserve('request-two')).call.id, second.call.id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM calls')).rows[0].n, 2);
    process.env.GLOBAL_CALL_MINUTES_PER_MONTH = '5'; // 60 seconds left in the shared free and trial pool
    const other = (await db.query("INSERT INTO users(phone) VALUES('+15555550104') RETURNING *")).rows[0];
    other.agent_number = '+15555550999';
    const inbound = () => db.transaction(tx => reserveCallInTransaction(tx, other, 'anonymous', true, 'incoming-CA_TEST',
      { direction: 'inbound', callSid: 'CA_TEST', contactId: null }));
    const incoming = await inbound();
    assert.equal(incoming.call.direction, 'inbound');
    assert.equal(incoming.call.twilio_call_sid, 'CA_TEST');
    assert.equal(incoming.call.agent_number, other.agent_number);
    assert.equal(incoming.call.twilio_account_sid, process.env.TWILIO_ACCOUNT_SID);
    assert.equal(incoming.call.max_duration_sec, 60, 'the grace never goes past the shared pool');
    assert.equal((await inbound()).created, false);
    await assert.rejects(reserve('request-three'), { code: 'call_minutes_limit' });
    // The founder's grant is not limited by the exhausted free pool.
    await db.query('UPDATE users SET minutes_override=600 WHERE id=$1', [owner.id]);
    const granted = await reserve('request-four', '+15555550105');
    assert.equal(granted.call.max_duration_sec, 1800, 'a granted account calls up to the 30-minute call cap');
  } finally {
    delete process.env.CALLS_PER_DAY; delete process.env.GLOBAL_CALL_MINUTES_PER_MONTH;
    await db.close();
  }
});

test('new calls snapshot notice consent with the owner side pre-agreed from their accepted terms', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const owner = (await db.query("INSERT INTO users(phone,terms_version) VALUES('+15555550101','2026-10-07') RETURNING *")).rows[0];
    process.env.RECORDING_CONSENT_MODE = 'owner_only';
    const out = await db.transaction(tx => reserveCallInTransaction(tx, owner, '+15555550102', true, 'out'));
    assert.equal(out.call.consent_mode, 'notice'); assert.equal(out.call.consent_scope, null);
    assert.ok(out.call.parent_consent_at); assert.equal(out.call.child_consent_at, null);
    assert.equal(out.call.other_party_notice_issued_at, null);
    await db.query("UPDATE calls SET status='completed',duration_sec=60 WHERE id=$1", [out.call.id]);
    const unrecorded = await db.transaction(tx => reserveCallInTransaction(tx, owner, '+15555550102', false, 'plain'));
    assert.equal(unrecorded.call.parent_consent_at, null);
    await db.query("UPDATE calls SET status='completed',duration_sec=60 WHERE id=$1", [unrecorded.call.id]);
    const inbound = await db.transaction(tx => reserveCallInTransaction(tx, owner, '+15555550103', true, 'in',
      { direction: 'inbound', callSid: 'CA' + 'e'.repeat(32), contactId: null }));
    assert.ok(inbound.call.child_consent_at); assert.equal(inbound.call.parent_consent_at, null);
  } finally { delete process.env.RECORDING_CONSENT_MODE; await db.close(); }
});

test('owners who have not accepted the current terms cannot place recorded calls; inbound connects unrecorded', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const owner = (await db.query("INSERT INTO users(phone,terms_version) VALUES('+15555550101','2020-01-01') RETURNING *")).rows[0];
    await assert.rejects(db.transaction(tx => reserveCallInTransaction(tx, owner, '+15555550102', true, 'out')),
      { status: 409, code: 'terms_required' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM calls')).rows[0].n, 0);
    const inbound = await db.transaction(tx => reserveCallInTransaction(tx, owner, '+15555550103', true, 'in',
      { direction: 'inbound', callSid: 'CA' + 'e'.repeat(32), contactId: null }));
    assert.equal(inbound.call.record_enabled, false);
    assert.equal(inbound.call.child_consent_at, null);
  } finally { await db.close(); }
});
