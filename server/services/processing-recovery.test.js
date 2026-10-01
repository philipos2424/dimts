import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
} });
let downloads = 0, transcriptions = 0, summaries = 0, identities = 0, failSummary = false, summarizeHook, transcribeHook, transcriptOverride;
mock.module('./originate.js', { namedExports: {
  fetchRecording: async () => { downloads++; return { ok: true, blob: async () => new Blob(['audio']) }; },
  isE164: () => true, originateCall: async () => { throw new Error('No phone calls in this test'); },
} });
mock.module('./transcribe.js', { namedExports: { transcribe: async () => {
  transcriptions++; if (transcribeHook) await transcribeHook();
  if (transcriptOverride) return transcriptOverride;
  return { text: 'Caller: Send a quote.\nUser: I will.', raw: { marker: 'saved transcription' }, language: 'eng', languageProbability: 0.99 };
} } });
mock.module('./summarize.js', { namedExports: { summarize: async () => {
  summaries++; if (failSummary) throw new Error('Summary service unavailable');
  const text = summarizeHook ? await summarizeHook() : 'A quote was requested.';
  return { summary: text, next_moves: [], action_items: [], key_points: [] };
} } });
mock.module('./identify.js', { namedExports: { identifyCaller: async () => { identities++; return { name: null, company: null, confidence: 0 }; } } });
const { processRecording } = await import('./process-recording.js');
const { expireProcessing } = await import('../db/expire-processing.js');
const { callsRouter } = await import('../routes/calls.js');
const app = express(); app.use('/calls', callsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'internal_error' }));
const server = app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
const tokens = ['a'.repeat(64), 'b'.repeat(64)], users = [];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [`+1555555010${i}`])).rows[0]; users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
}
const contact = (await db.query("INSERT INTO contacts(user_id,phone) VALUES($1,'+15555550103') RETURNING id", [users[0].id])).rows[0];
async function seed(owner = users[0].id) {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,recording_url,
    processing_requested_at,duration_sec) VALUES($1,'+15555550100','+15555550103',$2,'processing','saved-audio',now(),60) RETURNING id`, [owner, contact.id])).rows[0].id;
}
const row = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];
async function post(id, token = tokens[0]) {
  const response = await fetch(`${base}/calls/${id}/process`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, data: await response.json() };
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for worker'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
test.afterEach(() => { failSummary = false; summarizeHook = undefined; transcribeHook = undefined; transcriptOverride = undefined; });

test('one-sided audio preserves the partial checkpoint and blocks summaries and identity on initial processing and cached retry', async () => {
  const id = await seed(), beforeSummaries = summaries, beforeIdentities = identities, beforeTranscriptions = transcriptions;
  transcriptOverride = { text: 'Caller: Send a quote.', raw: { audio_quality: { status: 'missing_channel_signal' },
    transcripts: [{ text: 'Send a quote.' }, { text: '' }] }, language: 'eng', languageProbability: 0.99 };
  await assert.rejects(processRecording(id), /participant may have been quiet/);
  let saved = await row(id);
  assert.equal(saved.status, 'failed'); assert.equal(saved.recording_url, 'saved-audio');
  assert.equal(saved.transcript, transcriptOverride.text); assert.equal(saved.summary, null);
  assert.equal(saved.transcript_data.audio_quality.status, 'missing_channel_signal');
  await assert.rejects(processRecording(id), /participant may have been quiet/);
  assert.equal(transcriptions, beforeTranscriptions + 1); assert.equal(summaries, beforeSummaries); assert.equal(identities, beforeIdentities);
  // Replacement audio can pass the checks and produce notes normally.
  transcriptOverride = undefined;
  await db.query("UPDATE calls SET recording_url='replacement-audio' WHERE id=$1", [id]);
  await processRecording(id); saved = await row(id); assert.equal(saved.status, 'ready');
});

test('silent audio is retained with its diagnostics but never sent to the summary or identity model', async () => {
  const id = await seed(), beforeSummaries = summaries, beforeIdentities = identities;
  transcriptOverride = { text: '', raw: { audio_quality: { status: 'silent' }, transcripts: [{ text: '' }, { text: '' }] },
    language: null, languageProbability: null };
  await assert.rejects(processRecording(id), /no detectable audio signal/);
  const saved = await row(id); assert.equal(saved.recording_url, 'saved-audio'); assert.equal(saved.status, 'failed');
  assert.equal(saved.transcript_data.audio_quality.status, 'silent'); assert.equal(saved.summary, null);
  assert.equal(summaries, beforeSummaries); assert.equal(identities, beforeIdentities);
});

test('summary failure keeps transcription and audio; retry resumes without another download or transcription', async () => {
  const id = await seed(), beforeDownloads = downloads, beforeTranscripts = transcriptions;
  failSummary = true; await assert.rejects(processRecording(id), /Summary service/);
  let saved = await row(id); assert.equal(saved.status, 'failed'); assert.match(saved.transcript, /Send a quote/);
  assert.equal(saved.transcript_recording_url, 'saved-audio'); assert.equal(saved.transcript_data.marker, 'saved transcription');
  assert.equal(saved.recording_url, 'saved-audio'); assert.equal(saved.processing_token, null);
  failSummary = false; await processRecording(id);
  saved = await row(id); assert.equal(saved.status, 'ready'); assert.equal(saved.summary, 'A quote was requested.');
  assert.equal(downloads, beforeDownloads + 1); assert.equal(transcriptions, beforeTranscripts + 1);
  // A different recording must not reuse the old transcription.
  await db.query("UPDATE calls SET status='failed',recording_url='replacement-audio' WHERE id=$1", [id]);
  await processRecording(id); assert.equal(transcriptions, beforeTranscripts + 2);
});

test('expiry surfaces interrupted jobs and queued jobs without touching active jobs, other owners or ready notes', async () => {
  const expired = await seed(), queued = await seed(), active = await seed(), other = await seed(users[1].id), ready = await seed();
  for (const id of [expired, other]) await db.query("UPDATE calls SET processing_token=gen_random_uuid(),processing_until=now()-interval '1 second' WHERE id=$1", [id]);
  await db.query("UPDATE calls SET processing_requested_at=now()-interval '11 minutes' WHERE id=$1", [queued]);
  await db.query("UPDATE calls SET processing_token=gen_random_uuid(),processing_until=now()+interval '10 minutes' WHERE id=$1", [active]);
  await db.query("UPDATE calls SET status='ready',summary='Keep these notes',processing_until=now()-interval '1 second' WHERE id=$1", [ready]);
  await expireProcessing(users[0].id);
  for (const id of [expired, queued]) {
    const saved = await row(id); assert.equal(saved.status, 'failed'); assert.equal(saved.processing_token, null);
    assert.equal(saved.recording_url, 'saved-audio'); assert.match(saved.error, /recording is saved/);
  }
  assert.equal((await row(active)).status, 'processing'); assert.equal((await row(other)).status, 'processing');
  assert.equal((await row(ready)).summary, 'Keep these notes'); assert.equal((await row(ready)).status, 'ready');
});

test('legacy queued calls receive a fresh observation deadline before becoming retryable', async () => {
  const id = await seed(); await db.query('UPDATE calls SET processing_requested_at=NULL WHERE id=$1', [id]);
  await expireProcessing(users[0].id);
  assert.equal((await row(id)).status, 'processing'); assert.ok((await row(id)).processing_requested_at);
  await db.query("UPDATE calls SET processing_requested_at=now()-interval '11 minutes' WHERE id=$1", [id]);
  await expireProcessing(users[0].id); assert.equal((await row(id)).status, 'failed');
});

test('a stale worker cannot overwrite the new summary or identify the contact; only the winner spends on identification', async () => {
  const id = await seed(), beforeIdentities = identities, beforeTranscripts = transcriptions;
  let release, waiting = false, calls = 0;
  summarizeHook = async () => {
    calls++; if (calls === 1) { waiting = true; return new Promise(resolve => { release = () => resolve('Old summary'); }); }
    return 'New summary';
  };
  const old = processRecording(id); await until(() => waiting);
  await db.query("UPDATE calls SET processing_until=now()-interval '1 second' WHERE id=$1", [id]);
  await expireProcessing(users[0].id); await processRecording(id);
  release(); await old;
  assert.equal((await row(id)).summary, 'New summary'); assert.equal((await row(id)).status, 'ready');
  assert.equal(identities, beforeIdentities + 1); assert.equal(transcriptions, beforeTranscripts + 1);
});

test('ownership lost during transcription prevents checkpoint and further model spending', async () => {
  const id = await seed(), before = summaries;
  transcribeHook = async () => {
    await db.query("UPDATE calls SET processing_until=now()-interval '1 second' WHERE id=$1", [id]);
    await expireProcessing(users[0].id);
  };
  await assert.rejects(processRecording(id), /ownership changed/);
  assert.equal((await row(id)).transcript, null); assert.equal((await row(id)).status, 'failed');
  assert.equal(summaries, before);
});

test('retry endpoint rejects completed notes, active workers, missing audio and other accounts; concurrent retries only transcribe once', async () => {
  const id = await seed(); await processRecording(id);
  const before = transcriptions;
  assert.equal((await post(id)).status, 409); assert.equal((await post(id, tokens[1])).status, 404); assert.equal((await post(id, null)).status, 401);
  await db.query("UPDATE calls SET status='processing',processing_until=now()+interval '10 minutes' WHERE id=$1", [id]);
  assert.equal((await post(id)).status, 409);
  await db.query("UPDATE calls SET status='failed',processing_until=NULL,recording_url=NULL WHERE id=$1", [id]);
  assert.equal((await post(id)).status, 409); assert.equal(transcriptions, before);
  await db.query("UPDATE calls SET recording_url='new-audio' WHERE id=$1", [id]);
  const attempts = await Promise.all([post(id), post(id)]); assert.ok(attempts.some(r => r.status === 202));
  await until(async () => (await row(id)).status === 'ready');
  assert.equal(transcriptions, before + 1);
});
