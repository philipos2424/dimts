import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { hasRecordingAuthorization } from '../lib/recording-policy.js';
process.env.SKIP_TWILIO_SIGNATURE_CHECK = 'true';
process.env.PUBLIC_BASE_URL = 'https://example.test';
process.env.TWILIO_NUMBER = '+15555550999';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
} });
let starts = 0, processed = 0, failure, block, release;
const parent = 'CA' + 'a'.repeat(32), child = 'CA' + 'b'.repeat(32), recording = 'RE' + 'c'.repeat(32);
mock.module('../services/start-recording.js', { namedExports: {
  startCallRecording: async call => {
    starts++;
    assert.ok(hasRecordingAuthorization(call));
    assert.equal(call.twilio_call_sid, parent);
    if (block) await block;
    if (failure) throw failure;
    return recording;
  },
} });
mock.module('../services/process-recording.js', { namedExports: { processRecording: async () => { processed++; } } });
const { twimlRouter, webhooksRouter } = await import('./webhooks.js');
const app = express(); app.use(express.urlencoded({ extended: false })); app.use('/twiml', twimlRouter); app.use('/webhooks', webhooksRouter);
app.use((err, _req, res, _next) => res.status(500).send(err.message));
const server = app.listen(0), origin = `http://127.0.0.1:${server.address().port}`;
const user = (await db.query("INSERT INTO users(phone) VALUES('+15555550100') RETURNING id")).rows[0];
async function seed(direction = 'outbound', enabled = true) {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,direction,twilio_call_sid,status,record_enabled)
    VALUES($1,'+15555550100','+15555550101',$2,$3,'in-progress',$4) RETURNING id`, [user.id, direction, parent, enabled])).rows[0].id;
}
async function post(id, route, body = {}, choice = false) {
  const response = await fetch(`${origin}${route}?callId=${id}${choice ? '&choice=1' : ''}`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return { status: response.status, xml: await response.text() };
}
const row = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
test.afterEach(() => { failure = undefined; block = undefined; });
test('first-party decline and timeout connect unrecorded in either direction and count completed minutes', async () => {
  const before = starts;
  for (const [direction, digits] of [['outbound', '2'], ['inbound', '']]) {
    const id = await seed(direction);
    const result = await post(id, '/twiml/accept', { CallSid: parent, Digits: digits });
    assert.match(result.xml, /<Dial/); assert.match(result.xml, /record="do-not-record"/);
    assert.match(result.xml, new RegExp(direction === 'outbound' ? '15555550101' : '15555550100'));
    assert.equal((await row(id)).record_enabled, false);
    const party = await post(id, '/twiml/party-consent', { CallSid: child });
    assert.match(party.xml, /not being recorded/); assert.doesNotMatch(party.xml, /<Gather|<Hangup/);
    await post(id, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'completed', DialCallDuration: '60' });
    assert.equal((await row(id)).status, 'completed');
    // A forged later acceptance cannot reverse the saved refusal.
    await post(id, '/twiml/accept', { CallSid: parent, Digits: '1' });
    assert.equal((await row(id)).record_enabled, false);
  }
  assert.equal(starts, before);
  const usage = (await db.query('SELECT SUM(minutes_used) total FROM usage_minutes WHERE user_id=$1', [user.id])).rows[0];
  assert.equal(Number(usage.total), 2);
});
test('second-party decline and timeout bridge without any recording request or processing', async () => {
  const before = starts, processingBefore = processed;
  for (const digits of ['2', '']) {
    const id = await seed(); await post(id, '/twiml/accept', { CallSid: parent, Digits: '1' });
    const prompt = await post(id, '/twiml/party-consent', { CallSid: child });
    assert.match(prompt.xml, /actionOnEmptyResult="true"/);
    assert.match(prompt.xml, /choice=1/);
    const response = await post(id, '/twiml/party-consent', { CallSid: child, Digits: digits }, true);
    assert.doesNotMatch(response.xml, /<Hangup/); assert.match(response.xml, /without recording/);
    assert.equal((await row(id)).record_enabled, false);
    await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: recording, RecordingUrl: 'unexpected' });
    assert.equal((await row(id)).recording_url, null);
  }
  assert.equal(starts, before); assert.equal(processed, processingBefore);
});
test('both acceptances start once; concurrent replay and a wrong child SID cannot start another recorder', async () => {
  const id = await seed(), before = starts;
  await post(id, '/twiml/accept', { CallSid: parent, Digits: '1' });
  await post(id, '/twiml/party-consent', { CallSid: child });
  block = new Promise(resolve => { release = resolve; });
  const first = post(id, '/twiml/party-consent', { CallSid: child, Digits: '1' }, true);
  const deadline = Date.now() + 2000;
  while (starts === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(starts, before + 1);
  const repeated = await post(id, '/twiml/party-consent', { CallSid: child, Digits: '1' }, true);
  assert.equal(repeated.status, 200);
  assert.match((await post(id, '/twiml/party-consent', { CallSid: 'CA' + 'd'.repeat(32), Digits: '1' }, true)).xml, /<Hangup/);
  release(); await first; assert.equal(starts, before + 1);
  assert.equal((await row(id)).recording_start_status, 'started');
  await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: 'RE' + 'e'.repeat(32), RecordingUrl: 'wrong-recorder' });
  assert.equal((await row(id)).recording_url, null);
  await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: recording, RecordingUrl: 'expected' });
  assert.equal((await row(id)).recording_url, 'expected');
});
test('inbound all-parties (Gulf): caller agrees, owner is asked on their leg, recording starts once both agree', async () => {
  const id = await seed('inbound'), before = starts;
  const accepted = await post(id, '/twiml/accept', { CallSid: parent, Digits: '1' });
  assert.match(accepted.xml, /<Dial/); assert.match(accepted.xml, /15555550100/);
  const prompt = await post(id, '/twiml/party-consent', { CallSid: child });
  assert.match(prompt.xml, /<Gather/); assert.match(prompt.xml, /choice=1/);
  assert.equal(starts, before, 'nothing records on the caller agreeing alone');
  await post(id, '/twiml/party-consent', { CallSid: child, Digits: '1' }, true);
  assert.equal(starts, before + 1);
  assert.ok(hasRecordingAuthorization(await row(id)));
});
test('a missed incoming call the caller agreed to record offers voicemail once, then processes it as one channel', async () => {
  const id = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,direction,twilio_call_sid,status,record_enabled,
      consent_mode,child_consent_at,other_party_notice_issued_at)
    VALUES($1,'+15555550100','+15555550101','inbound',$2,'ringing',true,'notice',now(),now()) RETURNING id`, [user.id, parent])).rows[0].id;
  const missed = await post(id, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'no-answer', DialCallDuration: '0' });
  assert.match(missed.xml, /<Record[^>]*maxLength="120"/);
  assert.match(missed.xml, /recording-ready\?callId=/);
  assert.equal((await row(id)).voicemail, true);
  assert.match((await post(id, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'no-answer' })).xml, /<Hangup\/>/);
  assert.doesNotMatch((await post(id, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'no-answer' })).xml, /<Record/);
  const before = processed;
  await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: 'RE' + 'f'.repeat(32), RecordingUrl: 'voicemail-url', RecordingDuration: '42' });
  const saved = await row(id);
  assert.equal(saved.recording_url, 'voicemail-url'); assert.equal(saved.duration_sec, 42); assert.equal(saved.status, 'processing');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(processed, before + 1);
});

test('no voicemail for outbound calls, caller hang-ups, or callers who have not agreed to recording', async () => {
  const outbound = await seed('outbound');
  assert.doesNotMatch((await post(outbound, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'no-answer' })).xml, /<Record/);
  const gulf = await seed('inbound'); // all_parties with nobody's consent yet
  assert.doesNotMatch((await post(gulf, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'no-answer' })).xml, /<Record/);
  const hungUp = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,direction,twilio_call_sid,status,record_enabled,
      consent_mode,child_consent_at,other_party_notice_issued_at)
    VALUES($1,'+15555550100','+15555550101','inbound',$2,'ringing',true,'notice',now(),now()) RETURNING id`, [user.id, parent])).rows[0].id;
  assert.doesNotMatch((await post(hungUp, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'canceled' })).xml, /<Record/);
  assert.equal((await row(hungUp)).voicemail, false);
});

test('known recording refusal connects unrecorded; uncertain startup never retries and accepts a later receipt', async () => {
  for (const known of [true, false]) {
    const id = await seed(); await post(id, '/twiml/accept', { CallSid: parent, Digits: '1' });
    await post(id, '/twiml/party-consent', { CallSid: child });
    failure = known ? Object.assign(new Error('refused'), { status: 403 }) : new Error('timeout');
    const result = await post(id, '/twiml/party-consent', { CallSid: child, Digits: '1' }, true);
    assert.doesNotMatch(result.xml, /<Hangup/);
    assert.equal((await row(id)).recording_start_status, known ? 'failed' : 'unknown');
    const before = starts;
    await post(id, '/twiml/party-consent', { CallSid: child, Digits: '1' }, true);
    assert.equal(starts, before);
    if (!known) {
      await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: recording, RecordingUrl: 'late' });
      assert.equal((await row(id)).recording_start_status, 'started');
      assert.equal((await row(id)).recording_url, 'late');
    }
  }
});

test('late recording receipt recovers a completed call after its audio wait expires', async () => {
  const { expireRecordingWait } = await import('../db/expire-recording-wait.js');
  const id = await seed();
  await post(id, '/twiml/accept', { CallSid: parent, Digits: '1' });
  await post(id, '/twiml/party-consent', { CallSid: child });
  await post(id, '/twiml/party-consent', { CallSid: child, Digits: '1' }, true);
  await post(id, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'completed', DialCallDuration: '60' });
  assert.ok((await row(id)).completed_at);
  await db.query("UPDATE calls SET completed_at=now()-interval '11 minutes' WHERE id=$1", [id]);
  await expireRecordingWait(user.id);
  assert.equal((await row(id)).status, 'failed');
  const before = processed;
  await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: recording, RecordingUrl: 'delayed-audio' });
  assert.equal((await row(id)).status, 'processing'); assert.equal((await row(id)).error, null);
  assert.equal((await row(id)).recording_url, 'delayed-audio'); assert.equal(processed, before + 1);
  await expireRecordingWait(user.id);
  assert.equal((await row(id)).status, 'processing');
});

async function ownerSeed(direction = 'outbound') {
  const id = await seed(direction);
  await db.query("UPDATE calls SET consent_mode='owner_only',consent_scope='Operator-reviewed test scope' WHERE id=$1", [id]);
  return id;
}

test('owner-only outbound plays notice before starting, never fabricates other-party consent and starts once', async () => {
  const id = await ownerSeed(), before = starts;
  assert.match((await post(id, '/twiml/bridge', { CallSid: parent })).xml, /other person will hear/);
  await post(id, '/twiml/accept', { CallSid: parent, Digits: '1' });
  const notice = await post(id, '/twiml/party-consent', { CallSid: child });
  assert.match(notice.xml, /<Say.*recorded.*<Gather/s);
  assert.match(notice.xml, /actionOnEmptyResult="true"/);
  assert.match(notice.xml, /timeout="1"/);
  assert.doesNotMatch(notice.xml, /<Redirect|Press 1|to agree/); assert.equal(starts, before);
  await post(id, '/twiml/record-after-notice', { CallSid: child });
  await post(id, '/twiml/record-after-notice', { CallSid: child });
  assert.equal(starts, before + 1);
  const saved = await row(id);
  assert.ok(saved.parent_consent_at && saved.other_party_notice_issued_at);
  assert.equal(saved.child_consent_at, null); assert.equal(saved.child_consent_choice, null);
  assert.match((await post(id, '/twiml/record-after-notice', { CallSid: parent })).xml, /Hangup/);
  const processingBefore = processed;
  await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: recording, RecordingUrl: 'owner-audio' });
  assert.equal((await row(id)).recording_url, 'owner-audio'); assert.equal(processed, processingBefore + 1);
});

test('owner-only inbound asks the account owner on child leg; external caller cannot accept for the owner', async () => {
  const id = await ownerSeed('inbound'), before = starts;
  await db.query('UPDATE calls SET other_party_notice_issued_at=now() WHERE id=$1', [id]);
  assert.match((await post(id, '/twiml/accept', { CallSid: parent, Digits: '1' })).xml, /Hangup/);
  assert.equal((await row(id)).parent_consent_at, null);
  assert.match((await post(id, '/twiml/party-consent', { CallSid: child })).xml, /<Gather.*You can record/s);
  await post(id, '/twiml/party-consent', { CallSid: child, Digits: '1' }, true);
  assert.equal(starts, before + 1); assert.ok((await row(id)).child_consent_at);
  assert.equal((await row(id)).parent_consent_choice, null);
});

test('owner-only refusals, timeouts, missing notice or scope cannot start or process recording', async () => {
  const before = starts, processingBefore = processed;
  for (const direction of ['outbound', 'inbound']) for (const digits of ['2', '']) {
    const id = await ownerSeed(direction);
    await db.query('UPDATE calls SET other_party_notice_issued_at=now() WHERE id=$1', [id]);
    await post(id, direction === 'outbound' ? '/twiml/accept' : '/twiml/party-consent',
      { CallSid: direction === 'outbound' ? parent : child, Digits: digits }, direction === 'inbound');
    assert.equal((await row(id)).record_enabled, false);
    await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: recording, RecordingUrl: 'forbidden' });
    assert.equal((await row(id)).recording_url, null);
  }
  const missing = await ownerSeed();
  await post(missing, '/twiml/accept', { CallSid: parent, Digits: '1' });
  assert.match((await post(missing, '/twiml/record-after-notice', { CallSid: child })).xml, /Hangup/);
  await db.query("UPDATE calls SET consent_scope=NULL,child_call_sid=$2,other_party_notice_issued_at=now() WHERE id=$1", [missing, child]);
  assert.match((await post(missing, '/twiml/record-after-notice', { CallSid: child })).xml, /Hangup/);
  await post(missing, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: recording, RecordingUrl: 'forbidden' });
  assert.equal((await row(missing)).recording_url, null);
  assert.equal(starts, before); assert.equal(processed, processingBefore);
});
