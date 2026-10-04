import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
process.env.CARRIER = 'telnyx';
process.env.SKIP_TWILIO_SIGNATURE_CHECK = 'true';
process.env.PUBLIC_BASE_URL = 'https://example.test';
process.env.TELNYX_NUMBER = '+15555550999';
process.env.TELNYX_API_KEY = 'KEYtest';
process.env.TELNYX_ACCOUNT_SID = '6a9a7976-012e-45d2-9258-6f5dc68d861e';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
} });
let starts = 0, processed = 0;
mock.module('../services/start-recording.js', { namedExports: { startCallRecording: async () => { starts++; return 'unused'; } } });
mock.module('../services/process-recording.js', { namedExports: { processRecording: async () => { processed++; } } });
const { twimlRouter, webhooksRouter } = await import('./webhooks.js');
const { reconcileCall } = await import('../services/end-call.js');
const app = express(); app.use(express.urlencoded({ extended: false }));
app.use('/twiml', twimlRouter); app.use('/webhooks', webhooksRouter);
app.use((err, _req, res, _next) => res.status(500).send(err.message));
const server = app.listen(0), origin = `http://127.0.0.1:${server.address().port}`;
const user = (await db.query("INSERT INTO users(phone) VALUES('+15555550100') RETURNING id")).rows[0];
const realFetch = globalThis.fetch;
test.after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server.close(resolve)); await db.close(); delete process.env.CARRIER; });

const parent = 'v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg';
const child = 'v3:9X2vxPDFY2RHSJ1EdMS0RHRksMTg7ldNxdjWbVr9zBjbGjGsSe-aiQ';
const recording = '35094891-3290-4142-b2c2-b2eda57534cf';
async function seed(direction, { sid = parent, notice = false } = {}) {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,direction,twilio_call_sid,twilio_account_sid,status,record_enabled,consent_mode,
      parent_consent_at,child_consent_at,other_party_notice_issued_at)
    VALUES($1,'+15555550100','+15555550101',$2,$3,$4,'ringing',true,'notice',
      CASE WHEN $2='outbound' THEN now() END, CASE WHEN $2='inbound' THEN now() END, CASE WHEN $5 THEN now() END) RETURNING id`,
  [user.id, direction, sid, process.env.TELNYX_ACCOUNT_SID, notice])).rows[0].id;
}
async function post(id, route, body = {}) {
  const response = await realFetch(`${origin}${route}?callId=${id}`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return { status: response.status, xml: await response.text() };
}
const row = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];

test('outbound notice on Telnyx: the call SID comes from the first webhook, Dial records, and the notice plays in a Gather', async () => {
  const id = await seed('outbound', { sid: null });
  const bridge = await post(id, '/twiml/bridge', { CallSid: parent });
  assert.equal((await row(id)).twilio_call_sid, parent);
  assert.match(bridge.xml, /<Dial[^>]*record="record-from-answer-dual"/);
  const before = starts;
  const party = await post(id, '/twiml/party-consent', { CallSid: child });
  assert.match(party.xml, /<Gather[^>]*><Say>This call is recorded and summarized by Dimts AI\.<\/Say><\/Gather>/);
  assert.doesNotMatch(party.xml, /record-after-notice|<Redirect/);
  assert.ok((await row(id)).other_party_notice_issued_at);
  assert.equal(starts, before, 'no second recorder through the REST API');
  await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: recording, RecordingUrl: 'https://s3.example.com/r.mp3' });
  const saved = await row(id);
  assert.equal(saved.recording_sid, recording);
  assert.equal(saved.status, 'processing');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(processed, 1);
});

test('when Telnyx sends no dial-done receipt, the recording length becomes the call length and is billed once', async () => {
  const id = await seed('outbound');
  await db.query("UPDATE calls SET status='in-progress', other_party_notice_issued_at=now() WHERE id=$1", [id]);
  await post(id, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed', RecordingSid: '45094891-3290-4142-b2c2-b2eda57534cf',
    RecordingUrl: 'https://s3.example.com/r2.mp3', RecordingDuration: '62' });
  const saved = await row(id);
  assert.equal(saved.duration_sec, 62);
  assert.equal(saved.status, 'processing');
  const minutes = (await db.query('SELECT minutes_used FROM usage_minutes WHERE user_id=$1', [user.id])).rows[0];
  assert.ok(Math.abs(Number(minutes.minutes_used) - 62 / 60) < 0.001);
  await post(id, '/twiml/dial-done', { CallSid: parent, DialCallStatus: 'completed', DialCallDuration: '70' });
  assert.equal((await row(id)).duration_sec, 62, 'a late receipt does not bill twice');
});

test('inbound notice on Telnyx: the owner answering does not start a second recorder', async () => {
  const id = await seed('inbound', { notice: true });
  const before = starts;
  const party = await post(id, '/twiml/party-consent', { CallSid: child });
  assert.doesNotMatch(party.xml, /<Hangup/);
  assert.equal(starts, before);
});

test('ending a Telnyx call finds the dialled leg through the stored child SID', async () => {
  const id = await seed('outbound');
  await db.query("UPDATE calls SET child_call_sid=$2,status='in-progress' WHERE id=$1", [id, child]);
  const fetched = [];
  globalThis.fetch = async url => {
    fetched.push(String(url));
    const status = String(url).includes(encodeURIComponent(child)) ? { status: 'completed', duration: '42' } : { status: 'completed', duration: '50' };
    return new Response(JSON.stringify(status), { status: 200 });
  };
  try { assert.deepEqual(await reconcileCall(await row(id)), { ended: true }); }
  finally { globalThis.fetch = realFetch; }
  assert.ok(fetched.some(url => url.endsWith(`/Calls/${encodeURIComponent(child)}`)));
  assert.equal((await row(id)).duration_sec, 42);
});
