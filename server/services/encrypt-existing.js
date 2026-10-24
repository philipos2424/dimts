/**
 * Encrypt call content and audio stored before encryption at rest, and
 * re-encrypt anything sealed with a key other than the current one (rotation).
 * Each run handles one batch and skips finished rows, so it is safe to repeat:
 * the daily cron runs it until nothing is left, and
 * scripts/encrypt-existing.js runs it by hand.
 */
import { query, queryOne } from '../db/pool.js';
import { currentKeyId, openValue, sealJson, sealText, validateKeyring } from '../lib/field-crypto.js';
import { audioStoreConfigured, getAudio, headAudio, objectKey, putAudio, removeAudio } from './audio-store.js';

export async function encryptExisting({ dryRun = false, limit = 500, audioLimit = limit, log = () => {} } = {}) {
  validateKeyring();
  const current = currentKeyId();
  const totals = { calls: 0, contacts: 0, actions: 0, audio: 0, audioFailed: 0 };
  // Plaintext, or sealed with an older key. Values are tested raw, in SQL,
  // because the database layer opens sealed values on the way out.
  const stale = column => `(${column} IS NOT NULL AND ${column} NOT LIKE 'dmt1.${current}.%')`;
  const staleJson = column => `(${column} IS NOT NULL AND (jsonb_typeof(${column}) <> 'string' OR ${column} #>> '{}' NOT LIKE 'dmt1.${current}.%'))`;
  const TEXT = ['transcript', 'summary', 'recap'];
  // The structured facts of a call (promises, agreed prices with their verbatim quotes, next steps, contradictions).
  const JSON_COLUMNS = ['transcript_data', 'followups', 'next_moves', 'action_items', 'key_points', 'agreements', 'conflicts'];

  const { rows: calls } = await query(`SELECT id, user_id, ${[...TEXT, ...JSON_COLUMNS].join(', ')} FROM calls
    WHERE status <> 'processing' AND deleted_at IS NULL AND (${[...TEXT.map(stale), ...JSON_COLUMNS.map(staleJson)].join(' OR ')})
    ORDER BY created_at LIMIT $1`, [limit]);
  for (const call of calls) {
    if (dryRun) { log(`would encrypt call ${call.id}`); continue; }
    const context = column => ({ userId: call.user_id, rowId: call.id, field: `calls:${column}` });
    // Values arrive opened; sealing them again under the current key is idempotent.
    const values = [...TEXT.map(c => call[c] == null ? null : sealText(call[c], context(c))),
      ...JSON_COLUMNS.map(c => call[c] == null ? null : sealJson(call[c], context(c)))];
    const assignments = [...TEXT, ...JSON_COLUMNS].map((column, i) => `${column}=$${i + 2}${JSON_COLUMNS.includes(column) ? '::jsonb' : ''}`);
    const saved = await queryOne(`UPDATE calls SET ${assignments.join(', ')}
      WHERE id=$1 AND status <> 'processing' AND deleted_at IS NULL RETURNING id`, [call.id, ...values]);
    // A deletion that commits between the read and this write wins: deleted_at stops it.
    if (saved) totals.calls++;
  }

  const { rows: contacts } = await query(`SELECT id, user_id, notes FROM contacts WHERE notes <> '' AND ${stale('notes')}
    LIMIT $1`, [limit]);
  for (const contact of contacts) {
    if (dryRun) { log(`would encrypt notes of contact ${contact.id}`); continue; }
    await query('UPDATE contacts SET notes=$2 WHERE id=$1', [contact.id,
      sealText(contact.notes, { userId: contact.user_id, rowId: contact.id, field: 'contacts:notes' })]);
    totals.contacts++;
  }

  // Approved Calendar and Gmail drafts keep a snapshot of what was sent to Google.
  for (const [table, column] of [['calendar_actions', 'meeting'], ['email_actions', 'email']]) {
    const { rows } = await query(`SELECT id, user_id, ${column} AS value FROM ${table}
      WHERE ${staleJson(column)} AND ${column} <> '{}'::jsonb LIMIT $1`, [limit]);
    for (const row of rows) {
      if (dryRun) { log(`would encrypt ${table} ${row.id}`); continue; }
      // Aliased columns are not opened by the database layer; open explicitly.
      const value = openValue(row.value);
      // Deleting a call scrubs this snapshot to '{}'; never write the old one back.
      await query(`UPDATE ${table} SET ${column}=$2::jsonb WHERE id=$1 AND ${column} <> '{}'::jsonb
        AND EXISTS (SELECT 1 FROM calls c WHERE c.id=${table}.call_id AND c.deleted_at IS NULL)`, [row.id,
        sealJson(value, { userId: row.user_id, rowId: row.id, field: `${table}:${column}` })]);
      totals.actions++;
    }
  }

  // Audio: copy each plain .mp3 to an encrypted .enc object, verify it, switch
  // the call over, then remove the plain copy.
  const { rows: recordings } = audioStoreConfigured() ? await query(`SELECT id, user_id, audio_object_key FROM calls
    WHERE audio_object_key LIKE '%.mp3' AND deleted_at IS NULL ORDER BY created_at LIMIT $1`, [audioLimit]) : { rows: [] };
  for (const call of recordings) {
    if (dryRun) { log(`would encrypt audio of call ${call.id}`); continue; }
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
      log(`${call.id}  audio encrypted, plain copy ${removed}`);
      totals.audio++;
    } catch (err) {
      totals.audioFailed++;
      log(`${call.id}  audio not encrypted: ${err.message}`);
    }
  }


  return { ...totals, pending: { calls: calls.length, contacts: contacts.length, recordings: recordings.length } };
}
