import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { TERMS_VERSION } from '../lib/terms.js';

// app call audio over HTTP: raw part uploads, completion, the flag and playback.
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
process.env.DATA_ENCRYPTION_KEYS = `k1:${randomBytes(32).toString('base64')}`;
process.env.APP_CALLS_ENABLED = 'true';

const { openRows } = await import('../lib/field-crypto.js');
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: async (sql, p) => openRows(await db.query(sql, p)),
  queryOne: async (sql, p) => openRows(await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(tx => work({ query: async (sql, p) => openRows(await tx.query(sql, p)) })),
  getPool: () => ({}),
} });
const notes = [];
mock.module('../services/process-recording.js', { namedExports: { processRecording: async id => { notes.push(id); return { status: 'skipped' }; } } });

const stored = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (!href.startsWith('https://proj.supabase.co/storage/v1/')) throw new Error(`No real requests allowed: ${href}`);
  const name = decodeURIComponent(href.replace(/^.*\/call-audio\//, ''));
  if (init.method === 'POST') { stored.set(name, Buffer.from(init.body)); return Response.json({}); }
  const bytes = stored.get(name);
  if (!bytes) return new Response(null, { status: 400 });
  if (init.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(bytes.length) } });
  const range = init.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
  if (!range) return new Response(bytes);
  const end = Math.min(Number(range[2]), bytes.length - 1);
  return new Response(bytes.subarray(Number(range[1]), end + 1), { status: 206, headers: { 'content-range': `bytes ${range[1]}-${end}/${bytes.length}` } });
};

const { createApp } = await import('../create-app.js');
const svc = await import('../services/app-calls.js');
const { drainDeferredWork } = await import('../lib/defer.js');
const server = createApp().listen(0), base = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { globalThis.fetch = realFetch; await new Promise(r => server.close(r)); await db.close(); });

let seq = 0;
async function person() {
  const token = randomBytes(32).toString('hex');
  const u = (await db.query(`INSERT INTO users(phone,terms_version,trial_ends_at) VALUES($1,$2,now()+interval '3 days') RETURNING *`,
    [`+1555555${String(5000 + ++seq).padStart(4, '0')}`, TERMS_VERSION])).rows[0];
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), u.id]);
  return { ...u, token };
}
async function talked() {
  const caller = await person(), callee = await person();
  const { appCallId } = await svc.startAppCall(caller, callee, `key-${randomBytes(6).toString('hex')}`);
  await svc.answerAppCall(callee, appCallId);
  await svc.reportConnected(caller, appCallId);
  await svc.reportConnected(callee, appCallId);
  await db.query("UPDATE app_calls SET connected_at=now()-interval '2 minutes' WHERE id=$1", [appCallId]);
  await svc.endAppCall(caller, appCallId, 60);
  const app = (await db.query('SELECT * FROM app_calls WHERE id=$1', [appCallId])).rows[0];
  return { caller, callee, appCallId, callerCall: app.caller_call_id, calleeCall: app.callee_call_id };
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const putPart = (who, id, body, { index = 0, total = 1, checksum = sha(body), type = 'application/octet-stream' } = {}) =>
  realFetch(`${base}/api/calls/${id}/audio-part?index=${index}&total=${total}`, { method: 'PUT', body,
    headers: { Authorization: `Bearer ${who.token}`, 'X-Part-Sha256': checksum, ...(type ? { 'Content-Type': type } : {}) } });
const complete = (who, id, body) => realFetch(`${base}/api/calls/${id}/audio-complete`, { method: 'POST', body: JSON.stringify(body),
  headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' } });

test('the upload endpoints do not exist until APP_CALLS_ENABLED is on', async () => {
  const c = await talked();
  process.env.APP_CALLS_ENABLED = 'false';
  try {
    assert.equal((await putPart(c.caller, c.callerCall, Buffer.from('abc'))).status, 404);
    assert.equal((await complete(c.caller, c.callerCall, { offsetMs: 0, mime: 'audio/mp4' })).status, 404);
  } finally { process.env.APP_CALLS_ENABLED = 'true'; }
  assert.equal((await db.query('SELECT count(*)::int n FROM app_call_audio_parts')).rows[0].n, 0);
});

test('raw parts upload out of order, any content type, and complete into one encrypted object that plays with its own type', async () => {
  const c = await talked();
  const original = randomBytes(300_000);
  const parts = [original.subarray(0, 150_000), original.subarray(150_000)];
  assert.equal((await putPart(c.caller, c.callerCall, parts[1], { index: 1, total: 2, type: 'audio/mp4' })).status, 200);
  assert.equal((await putPart(c.caller, c.callerCall, parts[0], { index: 0, total: 2, type: null })).status, 200);
  assert.equal((await putPart(c.caller, c.callerCall, parts[0], { index: 0, total: 2 })).status, 200, 'a repeat is fine');
  const done = await complete(c.caller, c.callerCall, { offsetMs: 250, mime: 'audio/mp4' });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { status: 'complete' });
  await drainDeferredWork();
  assert.deepEqual(notes, [], 'no notes yet: the other person has not uploaded');
  const again = await complete(c.caller, c.callerCall, { offsetMs: 250, mime: 'audio/mp4' });
  assert.equal(again.status, 200, 'completing twice is harmless');

  const audio = await realFetch(`${base}/api/calls/${c.callerCall}/audio`, { headers: { Authorization: `Bearer ${c.caller.token}` } });
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  assert.ok(Buffer.from(await audio.arrayBuffer()).equals(original));
  assert.equal((await realFetch(`${base}/api/calls/${c.callerCall}/audio`, { headers: { Authorization: `Bearer ${c.callee.token}` } })).status, 404,
    'the other person cannot play my file');
});

test('a part that does not match its checksum, or is over 1 MiB, is refused', async () => {
  const c = await talked();
  const body = Buffer.from('hello');
  const bad = await putPart(c.caller, c.callerCall, body, { checksum: sha(Buffer.from('other')) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_checksum');
  assert.equal((await putPart(c.caller, c.callerCall, body, { checksum: '' })).status, 400);
  const big = Buffer.alloc(1024 * 1024 + 1, 7);
  const tooBig = await putPart(c.caller, c.callerCall, big);
  assert.equal(tooBig.status, 413);
  assert.equal((await tooBig.json()).error, 'part_too_large');
  const exact = Buffer.alloc(1024 * 1024, 7);
  assert.equal((await putPart(c.caller, c.callerCall, exact)).status, 200, 'exactly 1 MiB is allowed');
  const badQuery = await realFetch(`${base}/api/calls/${c.callerCall}/audio-part?index=x&total=1`, { method: 'PUT', body,
    headers: { Authorization: `Bearer ${c.caller.token}`, 'X-Part-Sha256': sha(body), 'Content-Type': 'application/octet-stream' } });
  assert.equal(badQuery.status, 400);
});

test('strangers, the other person and bad ids get 404; signing in is required', async () => {
  const c = await talked();
  const body = Buffer.from('abc');
  assert.equal((await putPart(c.callee, c.callerCall, body)).status, 404);
  assert.equal((await putPart(await person(), c.callerCall, body)).status, 404);
  assert.equal((await putPart(c.caller, 'not-a-uuid', body)).status, 404);
  assert.equal((await complete(c.callee, c.callerCall, { offsetMs: 0, mime: 'audio/mp4' })).status, 404);
  assert.equal((await complete(c.caller, 'not-a-uuid', { offsetMs: 0, mime: 'audio/mp4' })).status, 404);
  const anon = await realFetch(`${base}/api/calls/${c.callerCall}/audio-part?index=0&total=1`, { method: 'PUT', body,
    headers: { 'X-Part-Sha256': sha(body), 'Content-Type': 'application/octet-stream' } });
  assert.equal(anon.status, 401);
  const invalid = await complete(c.caller, c.callerCall, { offsetMs: 0, mime: 'video/mp4' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_mime');
});

test('completing both sides starts the notes for both people', async () => {
  const c = await talked();
  notes.length = 0;
  for (const [who, id] of [[c.caller, c.callerCall], [c.callee, c.calleeCall]]) {
    const body = randomBytes(1000);
    assert.equal((await putPart(who, id, body)).status, 200);
    assert.equal((await complete(who, id, { offsetMs: 0, mime: 'audio/ogg' })).status, 200);
  }
  await drainDeferredWork();
  assert.deepEqual([...new Set(notes)].sort(), [c.callerCall, c.calleeCall].sort());
  const rows = (await db.query('SELECT recording_url, own_audio_mime FROM calls WHERE app_call_id=$1', [c.appCallId])).rows;
  assert.ok(rows.every(r => r.recording_url === `dimts-app:${c.appCallId}` && r.own_audio_mime === 'audio/ogg'));
});

test('phone call playback is unchanged (audio/mpeg), and an app row never fetches its marker from the carrier', async () => {
  const u = await person();
  const phone = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,duration_sec,audio_object_key)
    VALUES($1,$2,'+15555550100','ready',60,NULL) RETURNING id`, [u.id, u.phone])).rows[0];
  const key = `${u.id}/${phone.id}.mp3`;
  stored.set(key, Buffer.from([1, 2, 3]));
  await db.query('UPDATE calls SET audio_object_key=$2 WHERE id=$1', [phone.id, key]);
  const played = await realFetch(`${base}/api/calls/${phone.id}/audio`, { headers: { Authorization: `Bearer ${u.token}` } });
  assert.equal(played.status, 200);
  assert.equal(played.headers.get('content-type'), 'audio/mpeg');
  const c = await talked();
  await db.query('UPDATE calls SET recording_url=$2 WHERE id=$1', [c.callerCall, `dimts-app:${c.appCallId}`]);
  assert.equal((await realFetch(`${base}/api/calls/${c.callerCall}/audio`, { headers: { Authorization: `Bearer ${c.caller.token}` } })).status, 404);
});

test('a manual retry of an app call still waits for the other person, and the call detail says whether notes are partial', async () => {
  const c = await talked();
  notes.length = 0;
  const body = randomBytes(500);
  await putPart(c.caller, c.callerCall, body);
  await complete(c.caller, c.callerCall, { offsetMs: 0, mime: 'audio/aac' });
  await drainDeferredWork();
  const retry = await realFetch(`${base}/api/calls/${c.callerCall}/process`, { method: 'POST', headers: { Authorization: `Bearer ${c.caller.token}` } });
  assert.equal(retry.status, 202);
  await drainDeferredWork();
  assert.deepEqual(notes, [], 'still waiting: no one-sided notes before the ten minutes');
  await db.query("UPDATE calls SET completed_at=now()-interval '11 minutes', notes_partial=true WHERE id=$1", [c.callerCall]);
  await realFetch(`${base}/api/calls/${c.callerCall}/process`, { method: 'POST', headers: { Authorization: `Bearer ${c.caller.token}` } });
  await drainDeferredWork();
  assert.deepEqual(notes, [c.callerCall]);
  const detail = await (await realFetch(`${base}/api/calls/${c.callerCall}`, { headers: { Authorization: `Bearer ${c.caller.token}` } })).json();
  assert.equal(detail.route, 'app');
  assert.equal(detail.notes_partial, true);
  assert.equal(detail.audio_url, `/api/calls/${c.callerCall}/audio`);
});
