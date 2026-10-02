import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
let failStore = false;
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => {
    if (failStore && sql.includes('recording_url=$4')) { failStore = false; throw new Error('Simulated storage failure'); }
    return (await db.query(sql, p)).rows[0];
  },
} });
let lookups = 0, processed = 0, mode = 'found', duringLookup;
const sid = 'RE' + 'c'.repeat(32), parent = 'CA' + 'b'.repeat(32), url = 'https://api.twilio.com/2010-04-01/Accounts/AC' + 'a'.repeat(32) + '/Recordings/' + sid;
mock.module('../services/find-recording.js', { namedExports: { findCompletedRecording: async call => {
  lookups++; assert.equal(call.twilio_call_sid, parent);
  if (duringLookup) await duringLookup(call);
  if (mode === 'error') throw new Error('secret-provider-payload');
  return mode === 'found' ? { status: mode, sid, url } : { status: mode };
} } });
mock.module('../services/process-recording.js', { namedExports: { processRecording: async () => { processed++; } } });
const { recordingRecoveryRouter } = await import('./recording-recovery.js');
const app = express(); app.use('/calls', recordingRecoveryRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'internal_error', message: err.status ? err.message : 'Something went wrong' }));
const server = app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
const users = [], tokens = ['a'.repeat(64), 'b'.repeat(64)];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [`+1555555010${i}`])).rows[0]; users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
}
async function seed() {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,duration_sec,
    twilio_call_sid,parent_consent_at,child_consent_at,recording_start_status,error)
    VALUES($1,'+15555550100','+15555550103','failed',60,$2,now(),now(),'unknown','No audio yet') RETURNING id`, [users[0].id, parent])).rows[0].id;
}
async function post(id, token = tokens[0]) {
  const response = await fetch(`${base}/calls/${id}/recording/reconcile`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, data: await response.json() };
}
const row = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
test.afterEach(() => { mode = 'found'; duringLookup = undefined; failStore = false; });

test('recovery saves an existing receipt once and repeated requests do not trigger another processing run', async () => {
  const id = await seed(), before = lookups, processingBefore = processed;
  assert.equal((await post(id)).status, 202);
  const saved = await row(id); assert.equal(saved.recording_url, url); assert.equal(saved.recording_sid, sid);
  assert.equal(saved.status, 'processing'); assert.equal(saved.error, null); assert.equal(saved.duration_sec, 60);
  assert.equal((await post(id)).data.status, 'available'); assert.equal(lookups, before + 1); assert.equal(processed, processingBefore + 1);
});

test('unsigned, other-owner, unrecorded, unagreed and unfinished calls cannot perform a provider lookup', async () => {
  const id = await seed(), before = lookups;
  assert.equal((await post(id, null)).status, 401); assert.equal((await post(id, tokens[1])).status, 404);
  for (const update of ["record_enabled=false", "record_enabled=true,parent_consent_at=NULL", "parent_consent_at=now(),child_consent_at=NULL", "child_consent_at=now(),duration_sec=NULL"]) {
    await db.query(`UPDATE calls SET ${update} WHERE id=$1`, [id]); assert.equal((await post(id)).status, 409);
  }
  assert.equal(lookups, before);
});

test('concurrent requests and repeated empty/error checks are limited without inventing a result', async () => {
  const id = await seed(), before = lookups;
  mode = 'unavailable';
  const results = await Promise.all([post(id), post(id)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 429]); assert.equal(lookups, before + 1);
  assert.equal((await row(id)).recording_url, null); assert.equal((await row(id)).status, 'failed');
  await db.query("UPDATE calls SET recording_lookup_until=now()-interval '1 second' WHERE id=$1", [id]);
  mode = 'error'; const failure = await post(id); assert.equal(failure.status, 503);
  assert.doesNotMatch(JSON.stringify(failure.data), /secret-provider/); assert.equal((await post(id)).status, 429);
});

test('a callback winning during lookup is not overwritten or processed twice', async () => {
  const id = await seed(), before = processed;
  duringLookup = call => db.query("UPDATE calls SET recording_url='callback-won',recording_sid=$2,status='processing',error=NULL WHERE id=$1", [call.id, sid]);
  assert.equal((await post(id)).data.status, 'available');
  assert.equal((await row(id)).recording_url, 'callback-won'); assert.equal(processed, before);
});

test('database failure after lookup retries only a read after cooldown; ambiguous and unsupported results are not accepted', async () => {
  const id = await seed(); failStore = true;
  assert.equal((await post(id)).status, 500); assert.equal((await row(id)).recording_url, null);
  assert.equal((await post(id)).status, 429);
  for (const status of ['ambiguous', 'unsupported', 'found']) {
    mode = status; await db.query("UPDATE calls SET recording_lookup_until=now()-interval '1 second' WHERE id=$1", [id]);
    const result = await post(id); assert.equal(result.data.status, status === 'found' ? 'processing' : status);
    assert.equal((await row(id)).recording_url, status === 'found' ? url : null);
  }
});

test('owner-only recovery accepts only the owner leg with scoped notice, in either direction', async () => {
  for (const direction of ['outbound', 'inbound']) {
    const id = await seed();
    const owner = direction === 'outbound' ? 'parent_consent_at' : 'child_consent_at';
    const other = direction === 'outbound' ? 'child_consent_at' : 'parent_consent_at';
    await db.query(`UPDATE calls SET direction=$2,consent_mode='owner_only',consent_scope='Reviewed test scope',
      ${owner}=NULL,${other}=now() WHERE id=$1`, [id, direction]);
    const before = lookups;
    assert.equal((await post(id)).status, 409);
    await db.query(`UPDATE calls SET ${owner}=now(),${other}=NULL WHERE id=$1`, [id]);
    assert.equal((await post(id)).status, 409, 'notice required');
    await db.query('UPDATE calls SET other_party_notice_issued_at=now(),consent_scope=NULL WHERE id=$1', [id]);
    assert.equal((await post(id)).status, 409, 'scope required'); assert.equal(lookups, before);
    await db.query("UPDATE calls SET consent_scope='Reviewed test scope' WHERE id=$1", [id]);
    assert.equal((await post(id)).status, 202); assert.equal(lookups, before + 1);
    assert.equal((await row(id))[other], null);
  }
});
