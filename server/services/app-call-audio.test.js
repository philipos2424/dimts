import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { TERMS_VERSION } from '../lib/terms.js';

// app call audio: own-voice upload, two-sided notes, waiting and expiry.
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
process.env.DATA_ENCRYPTION_KEYS = `k1:${randomBytes(32).toString('base64')}`;
process.env.TRANSCRIBE_PROVIDER = 'elevenlabs';
process.env.ELEVENLABS_API_KEY = 'xi-test';

const { openRows } = await import('../lib/field-crypto.js');
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: async (sql, p) => openRows(await db.query(sql, p)),
  queryOne: async (sql, p) => openRows(await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(tx => work({ query: async (sql, p) => openRows(await tx.query(sql, p)) })),
  getPool: () => ({}),
} });
const summarized = [];
mock.module('./summarize.js', { namedExports: {
  summarize: async text => { summarized.push(text); return { summary: 'Agreed next steps.', next_moves: [], action_items: [], key_points: [], agreements: [] }; },
} });
mock.module('./identify.js', { namedExports: { identifyCaller: async () => null } });

// A minimal Supabase Storage and a fake ElevenLabs. The "audio" is JSON naming
// the words each person said, so the transcript proves whose file was read.
const stored = new Map(), storageReads = [], scribe = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('https://proj.supabase.co/storage/v1/')) {
    if (init.method === 'DELETE') { for (const k of JSON.parse(init.body).prefixes) stored.delete(k); return Response.json([]); }
    const name = decodeURIComponent(href.replace(/^.*\/call-audio\//, ''));
    if (init.method === 'POST') { stored.set(name, Buffer.from(init.body)); return Response.json({}); }
    const bytes = stored.get(name);
    if (!bytes) return new Response(null, { status: 400 });
    if (init.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(bytes.length) } });
    storageReads.push(name);
    const range = init.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!range) return new Response(bytes);
    const end = Math.min(Number(range[2]), bytes.length - 1);
    return new Response(bytes.subarray(Number(range[1]), end + 1), { status: 206, headers: { 'content-range': `bytes ${range[1]}-${end}/${bytes.length}` } });
  }
  if (href.startsWith('https://api.elevenlabs.io/v1/speech-to-text')) {
    const file = init.body.get('file');
    scribe.push({ name: file.name, type: file.type, multi: init.body.get('use_multi_channel'), diarize: init.body.get('diarize') });
    const { words } = JSON.parse(await file.text());
    return Response.json({ language_code: 'en', language_probability: 0.9, text: words.map(w => w.text).join(' '),
      words: words.map(w => ({ ...w, type: 'word' })) });
  }
  throw new Error(`No real requests allowed: ${href}`);
};

const svc = await import('./app-calls.js');
const audio = await import('./app-call-audio.js');
const { drainDeferredWork } = await import('../lib/defer.js');
const { transcriptTurns } = await import('../lib/transcript-turns.js');
const { EXPIRE_RECORDING_WAIT_SQL } = await import('../db/expire-recording-wait.js');
const { scrubCall } = await import('./scrub-call.js');
test.after(async () => { globalThis.fetch = realFetch; await db.close(); });
test.beforeEach(() => { summarized.length = 0; storageReads.length = 0; scribe.length = 0; });

let seq = 0;
async function user() {
  return (await db.query(`INSERT INTO users(phone,terms_version,trial_ends_at) VALUES($1,$2,now()+interval '3 days') RETURNING *`,
    [`+1555555${String(4000 + ++seq).padStart(4, '0')}`, TERMS_VERSION])).rows[0];
}
const row = async id => openRows(await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];

/** Two people who talked for a minute; both rows are now waiting for audio. */
async function talked() {
  const caller = await user(), callee = await user();
  const { appCallId } = await svc.startAppCall(caller, callee, `key-${randomBytes(6).toString('hex')}`);
  await svc.answerAppCall(callee, appCallId);
  await svc.reportConnected(caller, appCallId);
  await svc.reportConnected(callee, appCallId);
  await db.query("UPDATE app_calls SET connected_at=now()-interval '2 minutes' WHERE id=$1", [appCallId]);
  await svc.endAppCall(caller, appCallId, 60);
  const app = (await db.query('SELECT * FROM app_calls WHERE id=$1', [appCallId])).rows[0];
  return { caller, callee, appCallId, callerCall: app.caller_call_id, calleeCall: app.callee_call_id };
}
const voice = words => Buffer.from(JSON.stringify({ words }));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function upload(who, callId, bytes, { offsetMs = 0, mime = 'audio/mp4', parts = 1 } = {}) {
  const size = Math.ceil(bytes.length / parts);
  for (let i = 0; i < parts; i++) {
    const body = bytes.subarray(i * size, (i + 1) * size);
    await audio.storeAudioPart(who, callId, { index: i, total: parts, sha256: sha(body), body });
  }
  const done = await audio.completeOwnAudio(who, callId, { offsetMs, mime });
  await drainDeferredWork();
  return done;
}
const callerWords = voice([{ text: 'Hello', start: 0.5, end: 0.9 }, { text: 'Sara', start: 1.0, end: 1.4 }, { text: 'deal?', start: 5.0, end: 5.5 }]);
const calleeWords = voice([{ text: 'Yes,', start: 2.0, end: 2.3 }, { text: 'agreed.', start: 2.4, end: 3.0 }]);

test('with both uploads, both rows are ready with two-sided notes and each person is "User" in their own transcript', async () => {
  const c = await talked();
  await upload(c.caller, c.callerCall, callerWords);
  assert.equal((await row(c.callerCall)).status, 'processing', 'the first upload waits for the other person');
  await upload(c.callee, c.calleeCall, calleeWords);
  const mine = await row(c.callerCall), theirs = await row(c.calleeCall);
  for (const r of [mine, theirs]) {
    assert.equal(r.status, 'ready', r.error);
    assert.equal(r.notes_partial, false);
    assert.equal(r.transcript_data.transcripts.length, 2);
    assert.equal(r.recording_url, `dimts-app:${c.appCallId}`);
    assert.equal(r.transcript_recording_url, r.recording_url);
    assert.ok(transcriptTurns(r).length > 0, 'timed turns are available');
    assert.equal(r.summary, 'Agreed next steps.');
  }
  assert.equal(mine.transcript, 'User: Hello Sara\nCaller: Yes, agreed.\nUser: deal?');
  assert.equal(theirs.transcript, 'Caller: Hello Sara\nUser: Yes, agreed.\nCaller: deal?');
  assert.equal(mine.direction, 'outbound');
  assert.equal(theirs.direction, 'inbound');
  assert.equal(mine.transcript_data.transcripts[0].text, 'Hello Sara deal?', 'outbound rows put the owner on channel 0');
  assert.equal(theirs.transcript_data.transcripts[1].text, 'Yes, agreed.', 'inbound rows put the owner on channel 1');
  assert.ok(scribe.every(s => s.multi === null && s.diarize === null), 'one voice per request, no diarization');
  assert.ok(scribe.every(s => s.name === 'recording.m4a' && s.type === 'audio/mp4'));
});

test('the peer\'s words are shifted onto this person\'s timeline by the difference of the recorder offsets, never below zero', async () => {
  const c = await talked();
  await upload(c.caller, c.callerCall, callerWords, { offsetMs: 300 });
  await upload(c.callee, c.calleeCall, calleeWords, { offsetMs: 2300 });
  const mine = await row(c.callerCall), theirs = await row(c.calleeCall);
  // The callee's recorder started 2 s after the caller's: their words move 2 s later.
  assert.deepEqual(mine.transcript_data.transcripts[1].words.map(w => [w.start, w.end]), [[4, 4.3], [4.4, 5]]);
  assert.equal(mine.transcript, 'User: Hello Sara\nCaller: Yes, agreed.\nUser: deal?');
  // And the caller's words move 2 s earlier for the callee; "Hello" would be negative.
  assert.deepEqual(theirs.transcript_data.transcripts[0].words.map(w => w.start), [0, 0, 3]);
  assert.equal(theirs.transcript, 'Caller: Hello Sara\nUser: Yes, agreed.\nCaller: deal?');
});

test('with one upload, the row waits; ten minutes after the call it is made one-sided and marked partial', async () => {
  const c = await talked();
  await upload(c.caller, c.callerCall, callerWords);
  assert.equal(await audio.processAppCallNotes(c.callerCall).then(r => r.status), 'waiting');
  let mine = await row(c.callerCall);
  assert.equal(mine.status, 'processing');
  assert.equal(mine.summary, null);
  await db.query("UPDATE calls SET completed_at=now()-interval '11 minutes' WHERE app_call_id=$1", [c.appCallId]);
  await audio.processAppCallNotes(c.callerCall);
  mine = await row(c.callerCall);
  assert.equal(mine.status, 'ready', mine.error);
  assert.equal(mine.notes_partial, true);
  assert.equal(mine.transcript, 'User: Hello Sara deal?');
  assert.deepEqual(mine.transcript_data.transcripts[1], { text: '', words: [] });
  assert.equal(summarized.length, 1);
  assert.equal((await row(c.calleeCall)).status, 'processing', 'the silent side keeps waiting for its upload');
});

test('the lazy sweep makes the waiting notes once the ten minutes have passed', async () => {
  const c = await talked();
  await upload(c.callee, c.calleeCall, calleeWords);
  await db.query("UPDATE calls SET completed_at=now()-interval '11 minutes' WHERE app_call_id=$1", [c.appCallId]);
  await svc.expireRingingAppCalls(c.callee.id);
  await drainDeferredWork();
  const theirs = await row(c.calleeCall);
  assert.equal(theirs.status, 'ready', theirs.error);
  assert.equal(theirs.notes_partial, true);
  assert.equal(theirs.transcript, 'User: Yes, agreed.');
});

test('a peer who deleted the call is never read: the row goes ahead at once, one-sided, and says so', async () => {
  const c = await talked();
  await upload(c.callee, c.calleeCall, calleeWords);
  const peerKey = (await row(c.calleeCall)).audio_object_key;
  assert.ok(peerKey);
  await db.transaction(async tx => scrubCall(tx, (await tx.query('SELECT * FROM calls WHERE id=$1', [c.calleeCall])).rows[0]));
  storageReads.length = 0;
  await upload(c.caller, c.callerCall, callerWords);
  const mine = await row(c.callerCall);
  assert.equal(mine.status, 'ready', mine.error);
  assert.equal(mine.notes_partial, true);
  assert.equal(mine.transcript, 'User: Hello Sara deal?');
  assert.ok(!storageReads.includes(peerKey), 'the deleted peer\'s audio was not read');
  assert.equal((await row(c.calleeCall)).status, 'deleted');
});

test('a peer who stopped being recordable does not contribute', async t => {
  t.mock.method(console, 'error', () => {}); // the peer's own row now fails (not authorized); expected here
  const c = await talked();
  await upload(c.callee, c.calleeCall, calleeWords);
  await db.query('UPDATE calls SET record_enabled=false WHERE id=$1', [c.calleeCall]);
  storageReads.length = 0;
  await upload(c.caller, c.callerCall, callerWords);
  const mine = await row(c.callerCall);
  assert.equal(mine.notes_partial, true);
  assert.equal(mine.transcript, 'User: Hello Sara deal?');
  assert.ok(!storageReads.includes((await row(c.calleeCall)).audio_object_key));
  const theirs = await row(c.calleeCall);
  assert.equal(theirs.status, 'failed');
  assert.equal(theirs.error, 'Recording was not authorized for this call.');
});

test('a silent own file with no other side yields the plain "no detectable audio" error and no notes', async t => {
  t.mock.method(console, 'error', () => {}); // the failed background job is reported; that is expected here
  const c = await talked();
  await db.query("UPDATE calls SET completed_at=now()-interval '11 minutes' WHERE app_call_id=$1", [c.appCallId]);
  await upload(c.caller, c.callerCall, voice([]));
  const mine = await row(c.callerCall);
  assert.equal(mine.status, 'failed');
  assert.match(mine.error, /no detectable audio signal/);
  assert.equal(mine.summary, null);
  assert.equal(mine.transcript_data.audio_quality.status, 'silent');
  assert.equal(summarized.length, 0);
});

test('when both uploaded but one person said nothing, the usual two-channel quality rule applies', async t => {
  t.mock.method(console, 'error', () => {}); // the failed background jobs are reported; that is expected here
  const c = await talked();
  await upload(c.caller, c.callerCall, callerWords);
  await upload(c.callee, c.calleeCall, voice([]));
  const mine = await row(c.callerCall);
  assert.equal(mine.status, 'failed');
  assert.match(mine.error, /both recording channels/);
  assert.equal(mine.notes_partial, false);
});

test('parts: idempotent per index, a changed part is 409, a missing part is 409, out-of-order parts reassemble exactly', async () => {
  const c = await talked();
  const original = randomBytes(5000);
  const parts = [original.subarray(0, 2000), original.subarray(2000, 4000), original.subarray(4000)];
  const put = (index, body, over = {}) => audio.storeAudioPart(c.caller, c.callerCall, { index, total: 3, sha256: sha(body), body, ...over });
  await put(2, parts[2]);
  await put(0, parts[0]);
  await put(0, parts[0]);
  await assert.rejects(put(0, parts[1]), e => e.status === 409 && e.code === 'part_conflict');
  await assert.rejects(audio.completeOwnAudio(c.caller, c.callerCall, { offsetMs: 0, mime: 'audio/mp4' }),
    e => e.status === 409 && e.code === 'parts_missing');
  await put(1, parts[1]);
  const { rows: atRest } = await db.query('SELECT data, encrypted FROM app_call_audio_parts WHERE call_id=$1', [c.callerCall]);
  assert.ok(atRest.every(p => p.encrypted && Buffer.from(p.data).indexOf(original.subarray(10, 42)) === -1), 'parts are encrypted at rest');
  assert.deepEqual(await audio.completeOwnAudio(c.caller, c.callerCall, { offsetMs: 0, mime: 'audio/mp4' }), { status: 'complete' });
  const saved = await row(c.callerCall);
  const { getAudio } = await import('./audio-store.js');
  assert.ok(Buffer.from(await (await getAudio(saved.audio_object_key)).arrayBuffer()).equals(original), 'byte-identical');
  assert.ok(saved.audio_object_key.endsWith('.enc'));
  assert.equal(saved.own_audio_mime, 'audio/mp4');
  assert.equal((await db.query('SELECT count(*)::int n FROM app_call_audio_parts WHERE call_id=$1', [c.callerCall])).rows[0].n, 0, 'parts are gone');
  assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE action='app_call_audio_uploaded' AND target_id=$1", [c.callerCall])).rows[0].n, 1);
  await drainDeferredWork();
});

test('complete is idempotent: a second call changes nothing', async () => {
  const c = await talked();
  await upload(c.caller, c.callerCall, callerWords, { offsetMs: 120 });
  const before = await row(c.callerCall);
  assert.deepEqual(await audio.completeOwnAudio(c.caller, c.callerCall, { offsetMs: 999, mime: 'audio/ogg' }), { status: 'complete' });
  const after = await row(c.callerCall);
  assert.equal(after.own_audio_offset_ms, 120);
  assert.equal(after.own_audio_mime, 'audio/mp4');
  assert.equal(String(after.own_audio_complete_at), String(before.own_audio_complete_at));
  await assert.rejects(audio.storeAudioPart(c.caller, c.callerCall, { index: 0, total: 1, sha256: sha(callerWords), body: callerWords }),
    e => e.status === 409 && e.code === 'audio_already_complete');
});

test('limits: part size, part count, index range, a changing total, total bytes, mime and offset', async () => {
  const c = await talked();
  const body = Buffer.from('abc');
  const put = over => audio.storeAudioPart(c.caller, c.callerCall, { index: 0, total: 1, sha256: sha(body), body, ...over });
  for (const over of [{ total: 0 }, { total: 41 }, { index: -1 }, { index: 1, total: 1 }, { index: 1.5, total: 3 }, { total: '2' }]) {
    await assert.rejects(put(over), e => e.status === 400 && e.code === 'invalid_part', JSON.stringify(over));
  }
  await assert.rejects(put({ body: Buffer.alloc(0), sha256: sha(Buffer.alloc(0)) }), e => e.status === 400 && e.code === 'invalid_part');
  const big = Buffer.alloc(1024 * 1024 + 1);
  await assert.rejects(put({ body: big, sha256: sha(big) }), e => e.status === 413 && e.code === 'part_too_large');
  await assert.rejects(put({ sha256: sha(Buffer.from('abd')) }), e => e.status === 400 && e.code === 'bad_checksum');
  await assert.rejects(put({ sha256: 'nope' }), e => e.status === 400 && e.code === 'bad_checksum');
  await put({ index: 0, total: 2 });
  await assert.rejects(put({ index: 1, total: 3 }), e => e.status === 409 && e.code === 'total_mismatch');
  // 40 parts of at most 1 MiB can never pass the 40 MiB total, which is checked anyway.
  assert.equal(audio.MAX_PARTS * audio.MAX_PART_BYTES, audio.MAX_AUDIO_BYTES);
  const e2 = await talked();
  await audio.storeAudioPart(e2.caller, e2.callerCall, { index: 0, total: 1, sha256: sha(body), body });
  for (const bad of [{ offsetMs: 0, mime: 'audio/flac' }, { offsetMs: 0, mime: 'text/plain' }, { offsetMs: 0 }]) {
    await assert.rejects(audio.completeOwnAudio(e2.caller, e2.callerCall, bad), e => e.status === 400 && e.code === 'invalid_mime', JSON.stringify(bad));
  }
  for (const offsetMs of [-1, 1.5, 600001, '5', undefined, null]) {
    await assert.rejects(audio.completeOwnAudio(e2.caller, e2.callerCall, { offsetMs, mime: 'audio/aac' }), e => e.status === 400 && e.code === 'invalid_offset', String(offsetMs));
  }
  for (const mime of audio.AUDIO_MIMES) assert.ok(['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-m4a'].includes(mime));
  assert.equal(audio.AUDIO_MIMES.length, 7);
});

test('only the row\'s owner may upload, only for a recordable app row whose peer has shown the notice', async () => {
  const c = await talked();
  const body = Buffer.from('abc');
  const put = (who, id) => audio.storeAudioPart(who, id, { index: 0, total: 1, sha256: sha(body), body });
  const stranger = await user();
  await assert.rejects(put(stranger, c.callerCall), e => e.status === 404);
  await assert.rejects(put(c.callee, c.callerCall), e => e.status === 404, 'the peer cannot upload to my row');
  await assert.rejects(put(c.caller, 'not-a-uuid'), e => e.status === 404);
  await assert.rejects(audio.completeOwnAudio(stranger, c.callerCall, { offsetMs: 0, mime: 'audio/mp4' }), e => e.status === 404);
  const phone = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,duration_sec,record_enabled) VALUES($1,$2,'+15555550100','processing',60,true) RETURNING id`,
    [c.caller.id, c.caller.phone])).rows[0];
  await assert.rejects(put(c.caller, phone.id), e => e.status === 404, 'a phone call takes no uploads');
  await db.query('UPDATE calls SET other_party_notice_issued_at=NULL WHERE id=$1', [c.callerCall]);
  await assert.rejects(put(c.caller, c.callerCall), e => e.status === 409 && e.code === 'recording_not_authorized');
  await db.query('UPDATE calls SET other_party_notice_issued_at=now(), record_enabled=false WHERE id=$1', [c.callerCall]);
  await assert.rejects(put(c.caller, c.callerCall), e => e.status === 409 && e.code === 'recording_not_authorized');
  await db.query("UPDATE calls SET record_enabled=true, deleted_at=now() WHERE id=$1", [c.callerCall]);
  await assert.rejects(put(c.caller, c.callerCall), e => e.status === 404);
  assert.equal((await db.query('SELECT count(*)::int n FROM app_call_audio_parts WHERE call_id=$1', [c.callerCall])).rows[0].n, 0);
});

test('expiry: an app row waiting for its upload survives the 10-minute phone rule and fails only after 48 hours', async () => {
  const c = await talked();
  await db.query("UPDATE calls SET completed_at=now()-interval '11 minutes' WHERE app_call_id=$1", [c.appCallId]);
  assert.equal((await db.query(EXPIRE_RECORDING_WAIT_SQL + ' RETURNING id', [c.caller.id])).rows.length, 0);
  await svc.expireRingingAppCalls(c.caller.id);
  assert.equal((await row(c.callerCall)).status, 'processing');
  await db.query("UPDATE calls SET completed_at=now()-interval '49 hours' WHERE app_call_id=$1", [c.appCallId]);
  assert.equal((await db.query(EXPIRE_RECORDING_WAIT_SQL + ' RETURNING id', [c.caller.id])).rows.length, 0, 'never the phone rule');
  await svc.expireRingingAppCalls(c.caller.id);
  const mine = await row(c.callerCall);
  assert.equal(mine.status, 'failed');
  assert.equal(mine.error, 'The call finished, but your notes could not be made because the recording was never received.');
  assert.equal((await row(c.calleeCall)).status, 'processing', 'each person\'s sweep handles their own rows');
});

test('the 10-minute processing expiry does not fail an app row that is waiting for the other upload', async () => {
  const c = await talked();
  await upload(c.caller, c.callerCall, callerWords);
  await db.query("UPDATE calls SET processing_requested_at=now()-interval '20 minutes' WHERE id=$1", [c.callerCall]);
  const { EXPIRE_PROCESSING_SQL } = await import('../db/expire-processing.js');
  assert.equal((await db.query(EXPIRE_PROCESSING_SQL + ' RETURNING id', [c.caller.id])).rows.length, 0);
  assert.equal((await row(c.callerCall)).status, 'processing');
});

test('parts older than 48 hours are swept', async () => {
  const c = await talked();
  const body = Buffer.from('abc');
  await audio.storeAudioPart(c.caller, c.callerCall, { index: 0, total: 2, sha256: sha(body), body });
  await svc.expireRingingAppCalls(c.caller.id);
  assert.equal((await db.query('SELECT count(*)::int n FROM app_call_audio_parts WHERE call_id=$1', [c.callerCall])).rows[0].n, 1);
  await db.query("UPDATE app_call_audio_parts SET created_at=now()-interval '49 hours' WHERE call_id=$1", [c.callerCall]);
  await svc.expireRingingAppCalls(c.caller.id);
  assert.equal((await db.query('SELECT count(*)::int n FROM app_call_audio_parts WHERE call_id=$1', [c.callerCall])).rows[0].n, 0);
});

test('deleting a call removes its parts and queues its audio for removal like a phone recording', async () => {
  const c = await talked();
  await upload(c.caller, c.callerCall, callerWords);
  const body = Buffer.from('abc');
  await audio.storeAudioPart(c.callee, c.calleeCall, { index: 0, total: 2, sha256: sha(body), body });
  for (const id of [c.callerCall, c.calleeCall]) {
    await db.query("UPDATE calls SET status='failed', processing_until=NULL WHERE id=$1", [id]);
    const deleted = await db.transaction(async tx => scrubCall(tx, (await tx.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0]));
    assert.equal(deleted.recording_url, null);
    assert.notEqual(deleted.provider_deletion_status, 'pending', 'there is no carrier copy to chase');
  }
  assert.equal((await row(c.callerCall)).storage_deletion_status, 'pending');
  assert.equal((await db.query('SELECT count(*)::int n FROM app_call_audio_parts WHERE call_id=$1', [c.calleeCall])).rows[0].n, 0);
  const { processDeletion } = await import('./process-deletion.js');
  const key = (await row(c.callerCall)).audio_object_key;
  await processDeletion(c.callerCall);
  assert.equal(stored.has(key), false);
  assert.equal((await row(c.callerCall)).audio_object_key, null);
});

test('a person can delete their account while their app call waits for uploads; the other person then gets one-sided notes', async () => {
  const c = await talked();
  await upload(c.caller, c.callerCall, callerWords);
  const { deleteAccount } = await import('./delete-account.js');
  await deleteAccount(c.callee.id);
  await drainDeferredWork();
  assert.equal((await row(c.calleeCall)).status, 'deleted');
  await svc.expireRingingAppCalls(c.caller.id);
  await drainDeferredWork();
  const mine = await row(c.callerCall);
  assert.equal(mine.status, 'ready', mine.error);
  assert.equal(mine.notes_partial, true);
});
