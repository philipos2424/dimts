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
let starts = 0;
const parent = 'CA' + 'a'.repeat(32), child = 'CA' + 'b'.repeat(32), recording = 'RE' + 'c'.repeat(32);
mock.module('../services/start-recording.js', { namedExports: {
  startCallRecording: async call => { starts++; assert.ok(hasRecordingAuthorization(call)); return recording; },
} });
mock.module('../services/process-recording.js', { namedExports: { processRecording: async () => {} } });
const { twimlRouter } = await import('./webhooks.js');
const app = express(); app.use(express.urlencoded({ extended: false })); app.use('/twiml', twimlRouter);
app.use((err, _req, res, _next) => res.status(500).send(err.message));
const server = app.listen(0), origin = `http://127.0.0.1:${server.address().port}`;
const user = (await db.query("INSERT INTO users(phone) VALUES('+15555550100') RETURNING id")).rows[0];
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });

async function seedNotice(direction, { owner = true, notice = false } = {}) {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,direction,twilio_call_sid,status,record_enabled,consent_mode,
      parent_consent_at,child_consent_at,other_party_notice_issued_at)
    VALUES($1,'+15555550100','+15555550101',$2,$3,'in-progress',true,'notice',
      CASE WHEN $4 AND $2='outbound' THEN now() END, CASE WHEN $4 AND $2='inbound' THEN now() END,
      CASE WHEN $5 THEN now() END) RETURNING id`, [user.id, direction, parent, owner, notice])).rows[0].id;
}
async function post(id, route, body = {}) {
  const response = await fetch(`${origin}${route}?callId=${id}`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return { status: response.status, xml: await response.text() };
}
const row = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];

test('outbound notice: bridge dials with no key press; the other person hears the notice; replays start one recorder', async () => {
  const id = await seedNotice('outbound');
  const bridge = await post(id, '/twiml/bridge', { CallSid: parent });
  assert.doesNotMatch(bridge.xml, /<Gather/);
  assert.match(bridge.xml, /<Dial/);
  const party = await post(id, '/twiml/party-consent', { CallSid: child });
  assert.match(party.xml, /This call is recorded and summarized by Dimts AI\./);
  assert.match(party.xml, /record-after-notice/);
  const noticed = (await row(id)).other_party_notice_issued_at;
  assert.ok(noticed);
  const before = starts;
  await post(id, '/twiml/record-after-notice', { CallSid: child });
  await post(id, '/twiml/record-after-notice', { CallSid: child });
  await post(id, '/twiml/party-consent', { CallSid: child });
  assert.equal(starts, before + 1);
  assert.equal((await row(id)).recording_start_status, 'started');
  assert.equal((await row(id)).other_party_notice_issued_at.getTime(), noticed.getTime());
});

test('inbound notice: the owner answering starts recording with no key press', async () => {
  const id = await seedNotice('inbound', { notice: true });
  const before = starts;
  const party = await post(id, '/twiml/party-consent', { CallSid: child });
  assert.doesNotMatch(party.xml, /<Gather/);
  assert.doesNotMatch(party.xml, /<Hangup/);
  assert.equal(starts, before + 1);
  assert.equal((await row(id)).recording_start_status, 'started');
});

test('a notice call never records before the other person has been given the notice', async () => {
  const id = await seedNotice('outbound');
  await db.query('UPDATE calls SET child_call_sid=$2 WHERE id=$1', [id, child]);
  const before = starts;
  const result = await post(id, '/twiml/record-after-notice', { CallSid: child });
  assert.match(result.xml, /<Hangup/);
  assert.equal(starts, before);
  assert.equal((await row(id)).recording_start_status, null);
});
