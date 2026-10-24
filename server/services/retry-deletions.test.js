import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const alerts = [], providerCalls = [], removals = [];
let providerResult = { status: 'confirmed' }, storeResult = 'confirmed', providerThrows = false;
mock.module('./delete-recording.js', { namedExports: { deleteProviderRecording: async call => {
  providerCalls.push(call.id); if (providerThrows) throw new Error('provider exploded'); return providerResult;
} } });
mock.module('./audio-store.js', { namedExports: { removeAudio: async key => { removals.push(key); return storeResult; } } });
mock.module('../lib/sentry.js', { namedExports: { captureCallFailure: (error, metadata) => alerts.push({ message: error.message, ...metadata }) } });
const { retryPendingDeletions } = await import('./retry-deletions.js');
test.after(() => db.close());
test.beforeEach(async () => {
  providerResult = { status: 'confirmed' }; storeResult = 'confirmed'; providerThrows = false;
  alerts.length = 0; providerCalls.length = 0; removals.length = 0;
  await db.exec('DELETE FROM calls');
});

let n = 0;
/** A call that was deleted and whose audio erasure has not been confirmed (or has). */
async function deletedCall({ provider = 'unknown', storage = 'pending', deleted = '1 hour', attempted = null, owner = 'gone' } = {}) {
  n++;
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [`+1555556${String(n).padStart(4, '0')}`])).rows[0];
  // Deleting an account leaves a tombstone: nobody can sign in as this user again.
  if (owner === 'gone') await db.query("UPDATE users SET phone='deleted:'||id, deleted_at=now() WHERE id=$1", [user.id]);
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,deleted_at,twilio_call_sid,recording_sid,twilio_account_sid,
      audio_object_key,provider_deletion_status,storage_deletion_status,provider_deletion_attempted_at)
    VALUES($1,'','','deleted',now()-$2::interval,$3,$4,$5,$6,$7,$8,CASE WHEN $9::text IS NULL THEN NULL ELSE now()-$9::interval END) RETURNING id`,
  [user.id, deleted, 'CA' + 'b'.repeat(32), 'RE' + 'c'.repeat(32), 'AC' + 'a'.repeat(32),
    storage === 'not_required' || storage === 'confirmed' ? null : `${user.id}/${n}.enc`, provider, storage, attempted])).rows[0].id;
}
const state = async id => (await db.query('SELECT provider_deletion_status p, storage_deletion_status s, audio_object_key k FROM calls WHERE id=$1', [id])).rows[0];

test('a stuck deletion is finished even though its owner deleted their account and can no longer sign in', async () => {
  const id = await deletedCall({ provider: 'unknown', storage: 'pending', owner: 'gone' });
  const result = await retryPendingDeletions();
  assert.deepEqual(await state(id), { p: 'confirmed', s: 'confirmed', k: null });
  assert.deepEqual([result.found, result.attempted, result.unresolved], [1, 1, 0]);
});

test('an uncertain outcome stays queued; it is not retried within the cooldown, and is retried after it', async () => {
  providerResult = { status: 'unknown', error: 'provider_unavailable' }; storeResult = 'unknown';
  const id = await deletedCall({ provider: 'pending', storage: 'pending' });
  const first = await retryPendingDeletions();
  assert.deepEqual([first.attempted, first.unresolved], [1, 1]);
  assert.deepEqual(Object.values(await state(id)).slice(0, 2), ['unknown', 'unknown']);
  const again = await retryPendingDeletions();
  assert.equal(again.attempted, 0, 'just tried; give the outage time');
  // Time passes, and the provider recovers.
  await db.query("UPDATE calls SET provider_deletion_attempted_at = now() - interval '2 hours' WHERE id=$1", [id]);
  providerResult = { status: 'confirmed' }; storeResult = 'confirmed';
  const later = await retryPendingDeletions();
  assert.deepEqual([later.attempted, later.unresolved], [1, 0]);
  assert.deepEqual(await state(id), { p: 'confirmed', s: 'confirmed', k: null });
});

test('calls already confirmed or needing no removal are left alone', async () => {
  await deletedCall({ provider: 'confirmed', storage: 'confirmed' });
  await deletedCall({ provider: 'not_required', storage: 'not_required' });
  const live = (await db.query(`INSERT INTO users(phone) VALUES('+15555560000') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,provider_deletion_status) VALUES($1,'+1','+2','ready','pending')`, [live]);
  const result = await retryPendingDeletions();
  assert.deepEqual([result.found, result.attempted, providerCalls.length, removals.length], [0, 0, 0, 0]);
});

test('the call tried longest ago goes first, so one call that keeps failing cannot starve the rest', async () => {
  providerResult = { status: 'unknown', error: 'provider_unavailable' }; storeResult = 'unknown';
  const recent = await deletedCall({ attempted: '3 hours' }), oldest = await deletedCall({ attempted: '10 hours' });
  const never = await deletedCall({ attempted: null });
  await retryPendingDeletions({ limit: 2 });
  assert.deepEqual(new Set(providerCalls), new Set([never, oldest]), 'never-tried and longest-ago, not the recent one');
  assert.ok(!providerCalls.includes(recent));
});

test('a provider crash on one call does not stop the others', async () => {
  const first = await deletedCall({ attempted: '5 hours' }), second = await deletedCall({ attempted: '4 hours' });
  providerThrows = true;
  const result = await retryPendingDeletions();
  assert.equal(result.attempted, 2, 'both were tried');
  providerThrows = false;
  // Two hours later the crashed attempt's one-minute lease has long expired.
  await db.query("UPDATE calls SET provider_deletion_attempted_at = now() - interval '2 hours', provider_deletion_until = now() - interval '2 hours'");
  assert.equal((await retryPendingDeletions()).unresolved, 0);
  assert.equal((await state(first)).p, 'confirmed'); assert.equal((await state(second)).p, 'confirmed');
});

test('a deletion still unconfirmed after three days raises an alert that names only the call and the stage', async () => {
  providerResult = { status: 'unknown', error: 'account_changed' }; storeResult = 'unknown';
  const old = await deletedCall({ deleted: '5 days', attempted: '30 hours' }), fresh = await deletedCall({ deleted: '2 hours', attempted: '30 hours' });
  const result = await retryPendingDeletions();
  assert.equal(result.overdue, 1);
  assert.deepEqual(alerts.map(a => [a.callId, a.stage]), [[old, 'deletion_overdue']]);
  assert.ok(!alerts.some(a => a.callId === fresh));
  assert.ok(!JSON.stringify(alerts).includes('CA' + 'b'.repeat(32)), 'no provider identifiers in the alert');
});

test('a call that finally succeeds raises no alert', async () => {
  await deletedCall({ deleted: '5 days', attempted: '30 hours' });
  await retryPendingDeletions();
  assert.deepEqual(alerts, []);
});

test('it stops starting new calls once its time budget is spent, leaving the rest for the next run', async () => {
  for (let i = 0; i < 6; i++) await deletedCall({ attempted: `${10 + i} hours` });
  const result = await retryPendingDeletions({ budgetMs: 0 });
  assert.ok(result.attempted < 6, 'not everything was attempted in a zero budget');
  assert.equal((await retryPendingDeletions()).unresolved, 0, 'the next run finishes the rest');
});
