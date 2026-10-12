import * as database from '../db/pool.js';
import { HttpError } from '../lib/users.js';
import { defer } from '../lib/defer.js';
import { assertDeletable, needsDeletionWork, scrubCall } from './scrub-call.js';
import { processDeletion } from './process-deletion.js';

async function scrubCalls(tx, rows) {
  // Only live work blocks erasure: an active lease, or a job queued in the
  // last 15 minutes that no worker has claimed yet. Expired leases do not.
  const now = Date.now();
  const live = call => call.status === 'processing' && (call.processing_until
    ? new Date(call.processing_until).getTime() > now
    : !call.processing_requested_at || now - new Date(call.processing_requested_at).getTime() < 15 * 60_000);
  if (rows.some(live)) {
    throw new HttpError(409, 'call_processing', 'Wait until your latest call notes are ready, then try again.');
  }
  for (const call of rows) await assertDeletable(tx, call);
  const scrubbed = [];
  for (const call of rows) scrubbed.push(await scrubCall(tx, call));
  return scrubbed.filter(needsDeletionWork).map(call => call.id);
}

function queueRemoval(ids) {
  for (const id of ids) defer(processDeletion(id), `delete:${id}`);
}

/**
 * Delete everything personal about an account in one transaction. The user
 * row survives as a tombstone so audit entries keep pointing at something;
 * signing in again with the same phone creates a new account.
 */
export async function deleteAccount(userId) {
  const queued = await database.withTransaction(async tx => {
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const { rows } = await tx.query('SELECT * FROM calls WHERE user_id=$1 AND deleted_at IS NULL FOR UPDATE', [userId]);
    const ids = await scrubCalls(tx, rows);
    await tx.query('UPDATE privacy_request_targets SET resolved_at=COALESCE(resolved_at,now()) WHERE user_id=$1', [userId]);
    for (const table of ['contacts', 'google_oauth_requests', 'google_connections', 'notification_devices', 'sessions', 'admin_passkeys', 'admin_challenges', 'user_identities']) {
      await tx.query(`DELETE FROM ${table} WHERE user_id=$1`, [userId]);
    }
    // Move the released number to the back of the queue so it is not
    // immediately reissued to someone else while old contacts still dial it.
    await tx.query(`UPDATE agent_number_pool SET checked_at=now()
      WHERE phone=(SELECT agent_number FROM users WHERE id=$1)`, [userId]);
    await tx.query(`UPDATE users SET phone='deleted:'||id, agent_number=NULL, deleted_at=now(),
      terms_version=NULL, terms_accepted_at=NULL WHERE id=$1`, [userId]);
    return ids;
  });
  queueRemoval(queued);
  return { queued: queued.length };
}

/** Delete one person and every call with them. */
export async function deleteContact(userId, contactId) {
  const queued = await database.withTransaction(async tx => {
    const contact = (await tx.query('SELECT id FROM contacts WHERE id=$1 AND user_id=$2 FOR UPDATE', [contactId, userId])).rows[0];
    if (!contact) throw new HttpError(404, 'contact_not_found');
    const { rows } = await tx.query('SELECT * FROM calls WHERE user_id=$1 AND contact_id=$2 AND deleted_at IS NULL FOR UPDATE', [userId, contactId]);
    const ids = await scrubCalls(tx, rows);
    await tx.query(`UPDATE privacy_request_targets SET resolved_at=now()
      WHERE user_id=$1 AND contact_id=$2 AND resolved_at IS NULL`, [userId, contactId]);
    await tx.query('UPDATE calls SET contact_id=NULL WHERE contact_id=$1', [contactId]);
    await tx.query('DELETE FROM contacts WHERE id=$1', [contactId]);
    return { ids, deleted: rows.length };
  });
  queueRemoval(queued.ids);
  return { deleted_calls: queued.deleted };
}
