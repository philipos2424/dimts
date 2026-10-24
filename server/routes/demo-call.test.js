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
process.env.TELNYX_TEXML_APP_ID = '1234567890';
process.env.TELNYX_ACCOUNT_SID = '6a9a7976-012e-45d2-9258-6f5dc68d861e';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
let starts = 0, processed = 0;
mock.module('../services/start-recording.js', { namedExports: {
  startCallRecording: async () => { starts++; return '35094891-3290-4142-b2c2-b2eda57534cf'; },
} });
mock.module('../services/process-recording.js', { namedExports: { processRecording: async () => { processed++; } } });
const { twimlRouter, webhooksRouter } = await import('./webhooks.js');
const { createDemoCall, DEMO_CALLS_PER_USER, DEMO_SCRIPT } = await import('../services/demo-call.js');
const app = express(); app.use(express.urlencoded({ extended: false }));
app.use('/twiml', twimlRouter); app.use('/webhooks', webhooksRouter);
app.use((err, _req, res, _next) => res.status(500).send(err.message));
const server = app.listen(0), origin = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
test.after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server.close(resolve)); await db.close(); delete process.env.CARRIER; });

const parent = 'v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg';
let phones = 0;
async function owner(fields = {}) {
  const phone = `+1555555${String(200 + phones++).padStart(4, '0')}`;
  return (await db.query(`INSERT INTO users(phone, terms_version) VALUES($1,$2) RETURNING *`,
    [phone, fields.terms === false ? null : '2026-10-07'])).rows[0];
}
// The carrier: creating a call returns no SID (Telnyx often does not), status fetches answer from `carrier`.
const created = [];
let carrier = { status: 'completed', duration: '58' };
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/Calls') && init?.method === 'POST') { created.push(JSON.parse(init.body)); return Response.json({}); }
  if (String(url).startsWith(origin)) return realFetch(url, init);
  return Response.json(carrier);
};
async function post(id, route, body = {}) {
  const response = await realFetch(`${origin}${route}?callId=${id}`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return { status: response.status, xml: await response.text() };
}
const row = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];
const finishActive = id => db.query(`UPDATE calls SET status='ready', duration_sec=1 WHERE id=$1`, [id]);

test('a demo rings the owner, plays the notice before recording, and files notes without billing', async () => {
  const user = await owner();
  const demo = await createDemoCall(user);
  assert.deepEqual(demo.script.map(line => line.client), DEMO_SCRIPT.map(line => line.client));
  assert.equal(created.at(-1).To, user.phone);
  assert.equal(created.at(-1).Url, `https://example.test/twiml/demo?callId=${demo.callId}`);

  const greeting = await post(demo.callId, '/twiml/demo', { CallSid: parent });
  assert.match(greeting.xml, /<Say>This call is recorded and summarized by Dimts AI\.<\/Say><Redirect[^>]*>https:\/\/example\.test\/twiml\/demo-script/);
  assert.equal((await row(demo.callId)).twilio_call_sid, parent);
  assert.equal(starts, 0, 'nothing records before the notice');

  const script = await post(demo.callId, '/twiml/demo-script', { CallSid: parent });
  assert.match(script.xml, /Alex Morgan[\s\S]*<Pause length="4"\/>[\s\S]*<Hangup\/>/);
  assert.equal(starts, 1);
  await post(demo.callId, '/twiml/demo-script', { CallSid: parent });
  assert.equal(starts, 1, 'a repeated request never starts a second recorder');

  // The carrier reports the hang-up before the recording is ready.
  await post(demo.callId, '/webhooks/call-status', { CallSid: parent, CallStatus: 'completed' });
  let saved = await row(demo.callId);
  assert.equal(saved.duration_sec, 58);
  assert.equal(saved.status, 'processing');
  await post(demo.callId, '/webhooks/recording-ready', { CallSid: parent, RecordingStatus: 'completed',
    RecordingSid: '35094891-3290-4142-b2c2-b2eda57534cf', RecordingUrl: 'https://s3.example.com/demo.mp3', RecordingDuration: '50' });
  await new Promise(resolve => setTimeout(resolve, 20));
  saved = await row(demo.callId);
  assert.equal(saved.recording_url, 'https://s3.example.com/demo.mp3');
  assert.equal(processed, 1);
  assert.equal((await db.query('SELECT * FROM usage_minutes WHERE user_id=$1', [user.id])).rows.length, 0, 'no minutes used');
  assert.equal((await db.query('SELECT * FROM credit_ledger WHERE user_id=$1', [user.id])).rows.length, 0, 'no credits charged');
  assert.equal((await db.query('SELECT trial_ends_at FROM users WHERE id=$1', [user.id])).rows[0].trial_ends_at, null, 'the trial clock does not start');
});

test('an unanswered demo fails with a reason and starts no recorder', async () => {
  const user = await owner();
  const demo = await createDemoCall(user);
  await db.query('UPDATE calls SET twilio_call_sid=$2 WHERE id=$1', [demo.callId, parent]);
  carrier = { status: 'no-answer', duration: '0' };
  try { await post(demo.callId, '/webhooks/call-status', { CallSid: parent, CallStatus: 'no-answer' }); }
  finally { carrier = { status: 'completed', duration: '58' }; }
  const saved = await row(demo.callId);
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /not answered/);
});

test('hanging up during the greeting ends the demo before any recording', async () => {
  const user = await owner();
  const demo = await createDemoCall(user);
  await post(demo.callId, '/twiml/demo', { CallSid: parent });
  await post(demo.callId, '/webhooks/call-status', { CallSid: parent, CallStatus: 'completed' });
  const saved = await row(demo.callId);
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /ended before/);
  const late = await post(demo.callId, '/twiml/demo-script', { CallSid: parent });
  assert.match(late.xml, /could not start/);
});

test('each owner gets a limited number of demos, deleted ones included', async () => {
  const user = await owner();
  for (let i = 0; i < DEMO_CALLS_PER_USER; i++) {
    const demo = await createDemoCall(user);
    await finishActive(demo.callId);
    await db.query('UPDATE calls SET deleted_at=now() WHERE id=$1', [demo.callId]);
  }
  await assert.rejects(createDemoCall(user), { status: 429, code: 'demo_limit' });
});

test('a demo needs accepted terms and no call in progress, and only demo rows answer the demo instructions', async () => {
  await assert.rejects(createDemoCall(await owner({ terms: false })), { status: 409, code: 'terms_required' });
  const user = await owner();
  const demo = await createDemoCall(user);
  await assert.rejects(createDemoCall(user), { status: 409, code: 'call_in_progress' });
  await finishActive(demo.callId);
  const real = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,direction,status,record_enabled,consent_mode,parent_consent_at)
    VALUES($1,$2,'+15555550101','outbound','initiating',true,'notice',now()) RETURNING id`, [user.id, user.phone])).rows[0].id;
  assert.match((await post(real, '/twiml/demo', { CallSid: parent })).xml, /<Hangup\/>/);
  assert.match((await post(real, '/twiml/demo-script', { CallSid: parent })).xml, /could not start/);
});

test('the carrier refusing the call marks the demo failed', async () => {
  const user = await owner();
  globalThis.fetch = async (url, init) => String(url).endsWith('/Calls') ? new Response('{}', { status: 422 }) : realFetch(url, init);
  try { await assert.rejects(createDemoCall(user), { status: 502, code: 'demo_call_failed' }); }
  finally {
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/Calls') && init?.method === 'POST') { created.push(JSON.parse(init.body)); return Response.json({}); }
      if (String(url).startsWith(origin)) return realFetch(url, init);
      return Response.json(carrier);
    };
  }
  const saved = (await db.query('SELECT status FROM calls WHERE user_id=$1', [user.id])).rows[0];
  assert.equal(saved.status, 'failed');
});
