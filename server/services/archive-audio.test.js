import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
} });
let configured = true, uploadError = null, storedSize = null, removed = [], providerCalls = 0, providerResult = { status: 'confirmed' };
mock.module('./audio-store.js', { namedExports: {
  audioStoreConfigured: () => configured,
  objectKey: (u, c) => `${u}/${c}.mp3`,
  putAudio: async (_key, bytes) => { if (uploadError) throw uploadError; return bytes.byteLength; },
  headAudio: async () => (storedSize == null ? null : { size: storedSize }),
  removeAudio: async key => { removed.push(key); return 'confirmed'; },
} });
mock.module('./delete-recording.js', { namedExports: {
  deleteProviderRecording: async () => { providerCalls++; return providerResult; },
} });
let downloads = 0;
mock.module('./originate.js', { namedExports: {
  isE164: () => true, originateCall: async () => {},
  fetchRecording: async () => { downloads++; return new Response(new Uint8Array([1, 2, 3, 4])); },
} });
const deferred = [];
mock.module('../lib/defer.js', { namedExports: { defer: (promise, label) => { deferred.push(label); return promise; } } });
const { archiveAudio, removeArchivedFromProvider, scheduleArchiveRetries } = await import('./archive-audio.js');
const user = (await db.query("INSERT INTO users(phone) VALUES('+15555550301') RETURNING id")).rows[0];
test.after(() => db.close());
test.beforeEach(() => { configured = true; uploadError = null; storedSize = null; removed = []; providerResult = { status: 'confirmed' }; });
const bytes = new Uint8Array([1, 2, 3, 4]);
async function seed(extra = '') {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,recording_url,recording_sid,twilio_call_sid)
    VALUES($1,'+1','+2','processing','https://api.twilio.com/x','RE${'c'.repeat(32)}','CA${'a'.repeat(32)}') RETURNING *`, [user.id])).rows[0];
}
const row = async id => (await db.query('SELECT * FROM calls WHERE id=$1', [id])).rows[0];

test('a verified upload records the object and queues removal from Twilio', async () => {
  const call = await seed(); storedSize = 4;
  assert.equal(await archiveAudio(call, bytes), 'stored');
  const saved = await row(call.id);
  assert.equal(saved.audio_object_key, `${user.id}/${call.id}.mp3`);
  assert.ok(saved.audio_archived_at);
  assert.equal(saved.provider_archive_status, 'pending');
});

test('a size mismatch after upload is a failure and never touches Twilio', async () => {
  const call = await seed(); storedSize = 3;
  const before = providerCalls;
  assert.equal(await archiveAudio(call, bytes), 'upload_failed');
  const saved = await row(call.id);
  assert.equal(saved.audio_object_key, null);
  assert.equal(saved.provider_archive_status, 'upload_failed');
  assert.equal(await removeArchivedFromProvider(call.id), 'skipped');
  assert.equal(providerCalls, before);
});

test('an upload error is recorded and reported without throwing', async () => {
  const call = await seed(); uploadError = new Error('storage down');
  assert.equal(await archiveAudio(call, bytes), 'upload_failed');
  assert.equal((await row(call.id)).provider_archive_status, 'upload_failed');
});

test('without storage configured, archiving is skipped and the row is unchanged', async () => {
  const call = await seed(); configured = false;
  assert.equal(await archiveAudio(call, bytes), 'skipped');
  const saved = await row(call.id);
  assert.equal(saved.audio_object_key, null); assert.equal(saved.provider_archive_status, null);
});

test('a call deleted while uploading keeps nothing in storage', async () => {
  const call = await seed(); storedSize = 4;
  await db.query("UPDATE calls SET deleted_at=now() WHERE id=$1", [call.id]);
  assert.equal(await archiveAudio(call, bytes), 'skipped');
  assert.deepEqual(removed, [`${user.id}/${call.id}.mp3`]);
  assert.equal((await row(call.id)).audio_object_key, null);
});

test('Twilio removal runs once per cooldown and records the verified outcome', async () => {
  const call = await seed(); storedSize = 4;
  await archiveAudio(call, bytes);
  const before = providerCalls;
  assert.equal(await removeArchivedFromProvider(call.id), 'removed');
  assert.equal(providerCalls, before + 1);
  assert.equal((await row(call.id)).provider_archive_status, 'removed');
  assert.equal(await removeArchivedFromProvider(call.id), 'skipped');
  const other = await seed(); await archiveAudio(other, bytes);
  providerResult = { status: 'unknown', error: 'provider_unavailable' };
  assert.equal(await removeArchivedFromProvider(other.id), 'unknown');
  assert.equal((await row(other.id)).provider_archive_status, 'unknown');
  assert.equal(await removeArchivedFromProvider(other.id), 'skipped', 'cooldown');
  await db.query("UPDATE calls SET provider_archive_attempted_at=now()-interval '2 minutes' WHERE id=$1", [other.id]);
  providerResult = { status: 'confirmed' };
  assert.equal(await removeArchivedFromProvider(other.id), 'removed');
});

test('listing calls retries pending Twilio removals and failed uploads for that user only', async () => {
  const other = (await db.query("INSERT INTO users(phone) VALUES('+15555550302') RETURNING id")).rows[0];
  await db.query("UPDATE calls SET provider_archive_status='removed' WHERE user_id=$1", [user.id]);
  const pending = await seed(); await db.query("UPDATE calls SET audio_object_key='k',provider_archive_status='pending' WHERE id=$1", [pending.id]);
  const failed = await seed(); await db.query("UPDATE calls SET status='ready',provider_archive_status='upload_failed' WHERE id=$1", [failed.id]);
  const done = await seed(); await db.query("UPDATE calls SET audio_object_key='k2',provider_archive_status='removed' WHERE id=$1", [done.id]);
  await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,recording_url,audio_object_key,provider_archive_status)
    VALUES($1,'+1','+2','ready','https://api.twilio.com/y','k3','pending')`, [other.id]);
  deferred.length = 0; downloads = 0; storedSize = 4;
  await scheduleArchiveRetries(user.id);
  assert.deepEqual(deferred.sort(), [`archive-remove:${pending.id}`, `archive-retry:${failed.id}`].sort());
  await new Promise(r => setTimeout(r, 20));
  assert.equal(downloads, 1);
  assert.equal((await row(failed.id)).provider_archive_status, 'pending', 'retried upload now stored');
});
