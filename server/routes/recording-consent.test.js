import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
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
    assert.ok(call.parent_consent_at && call.child_consent_at);
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
