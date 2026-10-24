import * as database from '../db/pool.js';
import { HttpError } from '../lib/users.js';
import { defer } from '../lib/defer.js';
import { assertDeletable, needsDeletionWork, scrubCall } from './scrub-call.js';
import { processDeletion } from './process-deletion.js';
import { numberQuarantineDays } from '../lib/number-quarantine.js';
import { trialPhoneHash } from '../lib/trial-tombstone.js';

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
    // Same lock order as reservation: deletion cannot race a first trial call.
    await tx.query('SELECT id FROM call_budget_lock WHERE id=1 FOR UPDATE');
    const user = (await tx.query('SELECT phone, trial_ends_at, deleted_at FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!user || user.deleted_at) return [];
    const { rows } = await tx.query('SELECT * FROM calls WHERE user_id=$1 AND deleted_at IS NULL FOR UPDATE', [userId]);
    const ids = await scrubCalls(tx, rows);
    await tx.query('UPDATE privacy_request_targets SET resolved_at=COALESCE(resolved_at,now()) WHERE user_id=$1', [userId]);
    for (const table of ['contacts', 'google_oauth_requests', 'google_connections', 'notification_devices', 'sessions', 'admin_passkeys', 'admin_challenges']) {
      await tx.query(`DELETE FROM ${table} WHERE user_id=$1`, [userId]);
    }
    // The timestamp marks prior trial use at deletion, starting 12-month retention.
    // Accounts that never used a trial leave no fingerprint.
    if (user.trial_ends_at) {
      await tx.query(`INSERT INTO trial_tombstones(phone_hash,trial_used_at) VALUES($1,now())
        ON CONFLICT(phone_hash) DO UPDATE SET trial_used_at=EXCLUDED.trial_used_at`, [trialPhoneHash(user.phone)]);
    }
    await tx.query(`UPDATE agent_number_pool SET checked_at=now(), available_after=now() + make_interval(days => $2)
      WHERE phone=(SELECT agent_number FROM users WHERE id=$1)`, [userId, numberQuarantineDays()]);
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
