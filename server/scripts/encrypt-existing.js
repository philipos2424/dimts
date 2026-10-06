// Encrypt call content and audio stored before encryption at rest, and
// re-encrypt anything sealed with a key other than the current one (rotation).
// Safe to re-run: finished rows are skipped. Run --dry-run first.
// Usage: node --env-file=../.env scripts/encrypt-existing.js [--dry-run] [--limit N]
import { query, queryOne, closeDatabase } from '../db/pool.js';
import { currentKeyId, openValue, sealJson, sealText, validateKeyring } from '../lib/field-crypto.js';
import { audioStoreConfigured, getAudio, headAudio, objectKey, putAudio, removeAudio } from '../services/audio-store.js';

const dryRun = process.argv.includes('--dry-run');
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex > -1 ? Number(process.argv[limitIndex + 1]) : 500;
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid --limit');
validateKeyring();
const current = currentKeyId();

// Plaintext, or sealed with an older key. Values are tested raw, in SQL,
// because the database layer opens sealed values on the way out.
const stale = column => `(${column} IS NOT NULL AND ${column} NOT LIKE 'dmt1.${current}.%')`;
const staleJson = column => `(${column} IS NOT NULL AND (jsonb_typeof(${column}) <> 'string' OR ${column} #>> '{}' NOT LIKE 'dmt1.${current}.%'))`;
const TEXT = ['transcript', 'summary', 'recap'], JSON_COLUMNS = ['transcript_data', 'followups'];

const totals = { calls: 0, contacts: 0, actions: 0, audio: 0, audioFailed: 0 };

const { rows: calls } = await query(`SELECT id, user_id, ${[...TEXT, ...JSON_COLUMNS].join(', ')} FROM calls
  WHERE status <> 'processing' AND (${[...TEXT.map(stale), ...JSON_COLUMNS.map(staleJson)].join(' OR ')})
  ORDER BY created_at LIMIT $1`, [limit]);
for (const call of calls) {
  if (dryRun) { console.log(`would encrypt call ${call.id}`); continue; }
  const context = column => ({ userId: call.user_id, rowId: call.id, field: `calls:${column}` });
  // Values arrive opened; sealing them again under the current key is idempotent.
  const values = [...TEXT.map(c => call[c] == null ? null : sealText(call[c], context(c))),
    ...JSON_COLUMNS.map(c => call[c] == null ? null : sealJson(call[c], context(c)))];
  const saved = await queryOne(`UPDATE calls SET transcript=$2, summary=$3, recap=$4, transcript_data=$5::jsonb, followups=$6::jsonb
    WHERE id=$1 AND status <> 'processing' RETURNING id`, [call.id, ...values]);
  if (saved) totals.calls++;
}

const { rows: contacts } = await query(`SELECT id, user_id, notes FROM contacts WHERE notes <> '' AND ${stale('notes')}
  LIMIT $1`, [limit]);
for (const contact of contacts) {
  if (dryRun) { console.log(`would encrypt notes of contact ${contact.id}`); continue; }
  await query('UPDATE contacts SET notes=$2 WHERE id=$1', [contact.id,
    sealText(contact.notes, { userId: contact.user_id, rowId: contact.id, field: 'contacts:notes' })]);
  totals.contacts++;
}

// Approved Calendar and Gmail drafts keep a snapshot of what was sent to Google.
for (const [table, column] of [['calendar_actions', 'meeting'], ['email_actions', 'email']]) {
  const { rows } = await query(`SELECT id, user_id, ${column} AS value FROM ${table}
    WHERE ${staleJson(column)} AND ${column} <> '{}'::jsonb LIMIT $1`, [limit]);
  for (const row of rows) {
    if (dryRun) { console.log(`would encrypt ${table} ${row.id}`); continue; }
    // Aliased columns are not opened by the database layer; open explicitly.
    const value = openValue(row.value);
    await query(`UPDATE ${table} SET ${column}=$2::jsonb WHERE id=$1`, [row.id,
      sealJson(value, { userId: row.user_id, rowId: row.id, field: `${table}:${column}` })]);
    totals.actions++;
  }
}

// Audio: copy each plain .mp3 to an encrypted .enc object, verify it, switch
// the call over, then remove the plain copy.
const { rows: recordings } = audioStoreConfigured() ? await query(`SELECT id, user_id, audio_object_key FROM calls
  WHERE audio_object_key LIKE '%.mp3' AND deleted_at IS NULL ORDER BY created_at LIMIT $1`, [limit]) : { rows: [] };
for (const call of recordings) {
  if (dryRun) { console.log(`would encrypt audio of call ${call.id}`); continue; }
  try {
    const response = await getAudio(call.audio_object_key);
    if (!response.ok) throw new Error(`read HTTP ${response.status}`);
    const plain = new Uint8Array(await response.arrayBuffer());
    const key = objectKey(call.user_id, call.id);
    const expected = await putAudio(key, plain);
    if ((await headAudio(key))?.size !== expected) throw new Error('stored size does not match');
    const check = Buffer.from(await (await getAudio(key)).arrayBuffer());
    if (!check.equals(Buffer.from(plain))) throw new Error('encrypted copy does not read back');
    const switched = await queryOne(`UPDATE calls SET audio_object_key=$3 WHERE id=$1 AND audio_object_key=$2
      AND deleted_at IS NULL RETURNING id`, [call.id, call.audio_object_key, key]);
    // Deleted meanwhile: neither copy may outlive the call.
    if (!switched) await removeAudio(key);
    const removed = await removeAudio(call.audio_object_key);
    console.log(`${call.id}  audio encrypted, plain copy ${removed}`);
    totals.audio++;
  } catch (err) {
    totals.audioFailed++;
    console.log(`${call.id}  audio not encrypted: ${err.message}`);
  }
}

console.log(dryRun
  ? `${calls.length} calls, ${contacts.length} contacts and ${recordings.length} recordings would be encrypted (one batch of up to ${limit} each).`
  : `encrypted ${totals.calls} calls, ${totals.contacts} contacts, ${totals.actions} Google drafts, ${totals.audio} recordings; ${totals.audioFailed} recordings failed. Re-run until nothing is left.`);
await closeDatabase();
