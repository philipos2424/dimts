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
let downloads = 0, unavailable = false, broken = false;
mock.module('../services/originate.js', { namedExports: {
  isE164: () => true, originateCall: async () => { throw new Error('No calls allowed in this test'); },
  fetchRecording: async (_url, { range } = {}) => {
    downloads++;
    if (unavailable) return new Response(null, { status: 404 });
    if (range === 'bytes=99-') return new Response(null, { status: 416, headers: { 'content-range': 'bytes */4' } });
    if (range) {
      assert.equal(range, 'bytes=1-2');
      return new Response(new Uint8Array([2, 3]), { status: 206, headers: { 'content-range': 'bytes 1-2/4', 'content-length': '2', 'accept-ranges': 'bytes' } });
    }
    if (broken) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      pull(controller) { controller.error(new Error('Upstream interrupted')); },
    }));
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '4' } });
  },
} });
let storeReads = [];
mock.module('../services/audio-store.js', { namedExports: {
  audioStoreConfigured: () => false, objectKey: (u, c) => `${u}/${c}.mp3`,
  putAudio: async () => {}, headAudio: async () => null, removeAudio: async () => 'confirmed',
  getAudio: async (key, { range } = {}) => {
    storeReads.push([key, range ?? null]);
    if (range) return new Response(new Uint8Array([6]), { status: 206, headers: { 'content-range': 'bytes 1-1/3', 'content-length': '1', 'accept-ranges': 'bytes' } });
    return new Response(new Uint8Array([5, 6, 7]), { headers: { 'content-length': '3', 'accept-ranges': 'bytes' } });
  },
} });
const { callsRouter } = await import('./calls.js');
const app = express(); app.use('/calls', callsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'internal_error' }));
const server = app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
const tokens = ['a'.repeat(64), 'b'.repeat(64)], users = [];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [`+1555555010${i}`])).rows[0];
  users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash('sha256').update(token).digest('hex'), user.id]);
}
const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,recording_url)
  VALUES($1,'+15555550100','+15555550103','ready','provider-only-url') RETURNING id`, [users[0].id])).rows[0];
function request(token = tokens[0], range) {
  return fetch(`${base}/calls/${call.id}/audio`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(range ? { Range: range } : {}) } });
}
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
test.afterEach(() => { unavailable = false; broken = false; });

test('only the signed-in owner downloads audio; unauthenticated and other-account requests never fetch media', async () => {
  const before = downloads;
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(tokens[1])).status, 404);
  assert.equal(downloads, before);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-type'), /audio\/mpeg/);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
});

test('provider media absence is explicit and leaves the call and recording reference intact', async () => {
  unavailable = true;
  const response = await request();
  assert.equal(response.status, 502); assert.equal((await response.json()).error, 'recording_fetch_failed');
  assert.equal((await db.query('SELECT recording_url FROM calls WHERE id=$1', [call.id])).rows[0].recording_url, 'provider-only-url');
});

test('an interrupted upstream stream fails the request without crashing subsequent playback', async () => {
  broken = true;
  await assert.rejects(async () => { const response = await request(); await response.arrayBuffer(); });
  broken = false;
  const retry = await request(); assert.equal(retry.status, 200);
  assert.equal((await retry.arrayBuffer()).byteLength, 4);
});

test('native seeking preserves partial content and unsatisfiable ranges; malformed ranges never reach the provider', async () => {
  const before = downloads;
  assert.equal((await request(tokens[0], 'bytes=0-1,2-3')).status, 416);
  assert.equal(downloads, before);
  const partial = await request(tokens[0], 'bytes=1-2');
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 1-2/4');
  assert.equal(partial.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [2, 3]);
  const absent = await request(tokens[0], 'bytes=99-');
  assert.equal(absent.status, 416); assert.equal(absent.headers.get('content-range'), 'bytes */4');
});

test('archived audio streams from EU storage, supports seeking, and each hour of listening is audited once', async () => {
  const archived = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,recording_url,audio_object_key)
    VALUES($1,'+15555550100','+15555550103','ready','provider-only-url',$2) RETURNING id`,
    [users[0].id, `${users[0].id}/archived.mp3`])).rows[0];
  const before = downloads;
  const get = range => fetch(`${base}/calls/${archived.id}/audio`, { headers: { Authorization: `Bearer ${tokens[0]}`, ...(range ? { Range: range } : {}) } });
  const full = await get();
  assert.equal(full.status, 200);
  assert.deepEqual([...new Uint8Array(await full.arrayBuffer())], [5, 6, 7]);
  const part = await get('bytes=1-1');
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 1-1/3');
  await part.arrayBuffer();
  assert.equal(downloads, before, 'Twilio is never contacted for archived audio');
  assert.deepEqual(storeReads.map(r => r[1]), [null, 'bytes=1-1']);
  const audited = (await db.query("SELECT count(*)::int n FROM audit_events WHERE action='audio_played' AND target_id=$1", [archived.id])).rows[0].n;
  assert.equal(audited, 1);
  const other = await fetch(`${base}/calls/${archived.id}/audio`, { headers: { Authorization: `Bearer ${tokens[1]}` } });
  assert.equal(other.status, 404);
});
