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
    const owner = (await db.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING *")).rows[0];
    const reserve = (key, dest = '+15555550102', record = true) => db.transaction(tx => reserveCallInTransaction(tx, owner, dest, record, key));
    process.env.TWILIO_ACCOUNT_SID = 'invalid';
    await assert.rejects(reserve('invalid-account'), /Invalid TWILIO_ACCOUNT_SID/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM calls')).rows[0].n, 0);
    process.env.TWILIO_ACCOUNT_SID = account;
    const pair = await Promise.all([reserve('request-one'), reserve('request-one')]);
    assert.equal(pair[0].call.id, pair[1].call.id);
    assert.equal(pair.filter(r => r.created).length, 1);
    assert.equal(pair[0].call.max_duration_sec, 1800);
    assert.equal(pair[0].call.twilio_account_sid, account);
    process.env.TWILIO_ACCOUNT_SID = 'AC' + 'd'.repeat(32);
    assert.equal((await reserve('request-one')).call.twilio_account_sid, account, 'retry retains original account');
    await assert.rejects(reserve('request-one', '+15555550103'), { code: 'request_key_reused' });
    await assert.rejects(reserve('request-one', '+15555550102', false), { code: 'request_key_reused' });
    await assert.rejects(reserve('request-two'), { code: 'call_in_progress' });
    await db.query("UPDATE calls SET status='completed',duration_sec=60 WHERE id=$1", [pair[0].call.id]);
    process.env.CALL_MINUTES_PER_MONTH = '2';
    const second = await reserve('request-two');
    assert.equal(second.call.max_duration_sec, 60, 'cap uses remaining minutes');
    await db.query("UPDATE calls SET status='failed' WHERE id=$1", [second.call.id]);
    await assert.rejects(reserve('request-three'), { code: 'call_minutes_limit' });
    await db.query('UPDATE calls SET budget_released=true WHERE id=$1', [second.call.id]);
    process.env.CALLS_PER_DAY = '2';
    await assert.rejects(reserve('request-three'), { code: 'daily_call_limit' });
    process.env.CALLS_PER_DAY = '10';
    process.env.GLOBAL_CALL_MINUTES_PER_MONTH = '1';
    await assert.rejects(reserve('request-three'), { code: 'call_minutes_limit' });
    // Idempotency lookup still works after a budget is exhausted.
    assert.equal((await reserve('request-two')).call.id, second.call.id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM calls')).rows[0].n, 2);
    process.env.GLOBAL_CALL_MINUTES_PER_MONTH = '2';
    const other = (await db.query("INSERT INTO users(phone) VALUES('+15555550104') RETURNING *")).rows[0];
    other.agent_number = '+15555550999';
    const inbound = () => db.transaction(tx => reserveCallInTransaction(tx, other, 'anonymous', true, 'incoming-CA_TEST',
      { direction: 'inbound', callSid: 'CA_TEST', contactId: null }));
    const incoming = await inbound();
    assert.equal(incoming.call.direction, 'inbound');
    assert.equal(incoming.call.twilio_call_sid, 'CA_TEST');
    assert.equal(incoming.call.agent_number, other.agent_number);
    assert.equal(incoming.call.twilio_account_sid, process.env.TWILIO_ACCOUNT_SID);
    assert.equal(incoming.call.max_duration_sec, 60);
    assert.equal((await inbound()).created, false);
    await assert.rejects(reserve('request-three'), { code: 'call_minutes_limit' });
  } finally {
    delete process.env.CALL_MINUTES_PER_MONTH; delete process.env.CALLS_PER_DAY; delete process.env.GLOBAL_CALL_MINUTES_PER_MONTH;
    await db.close();
  }
});

test('reservation snapshots policy and scope; retries preserve them after deployment settings change', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const owner = (await db.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING *")).rows[0];
    const reserve = key => db.transaction(tx => reserveCallInTransaction(tx, owner, '+15555550102', true, key));
    process.env.RECORDING_CONSENT_MODE='owner_only';
    await assert.rejects(reserve('missing-scope'), /APPROVED_SCOPE/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM calls')).rows[0].n, 0);
    process.env.RECORDING_OWNER_ONLY_APPROVED_SCOPE='Reviewed pilot';
    const first=await reserve('original');
    assert.equal(first.call.consent_mode,'owner_only'); assert.equal(first.call.consent_scope,'Reviewed pilot');
    process.env.RECORDING_CONSENT_MODE='all_parties'; delete process.env.RECORDING_OWNER_ONLY_APPROVED_SCOPE;
    const retry=await reserve('original'); assert.equal(retry.call.consent_mode,'owner_only'); assert.equal(retry.call.consent_scope,'Reviewed pilot');
    await db.query("UPDATE calls SET status='completed',duration_sec=60 WHERE id=$1", [first.call.id]);
    const second=await reserve('new'); assert.equal(second.call.consent_mode,'all_parties'); assert.equal(second.call.consent_scope,null);
  } finally {
    delete process.env.RECORDING_CONSENT_MODE; delete process.env.RECORDING_OWNER_ONLY_APPROVED_SCOPE; await db.close();
  }
});
