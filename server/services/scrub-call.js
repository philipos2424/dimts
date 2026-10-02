import { HttpError } from '../lib/users.js';
import { recordingAccount } from '../lib/recording-account.js';

/** Refuse deletion while a call or an external action is still unresolved. */
export async function assertDeletable(tx, current) {
  if (['initiating','ringing','in-progress'].includes(current.status) ||
      (current.duration_sec == null && !current.budget_released)) throw new HttpError(409, 'call_not_finished', 'Wait until the call has finished before deleting it.');
  for (const table of ['calendar_actions','email_actions']) {
    const { rows } = await tx.query(`SELECT id FROM ${table} WHERE call_id=$1 AND status IN ('pending','unknown')`, [current.id]);
    if (rows.length) throw new HttpError(409, 'external_action_unresolved', 'Check the pending calendar or Gmail action before deleting this call.');
  }
}

/**
 * Remove a call's content inside the caller's transaction. Provider and
 * storage copies are queued; processDeletion removes them after commit.
 */
export async function scrubCall(tx, current) {
  const needsProvider = !!(current.recording_url || current.recording_sid || current.recording_start_status === 'started' ||
    current.recording_start_status === 'unknown' || current.recording_start_status === 'pending');
  // Twilio's copy was already verified gone when the audio was archived.
  const providerStatus = needsProvider && current.provider_archive_status !== 'removed' ? 'pending'
    : needsProvider ? 'confirmed' : 'not_required';
  const { rows: [deleted] } = await tx.query(`UPDATE calls SET deleted_at=now(),status='deleted',record_enabled=false,
    destination='',user_phone='',contact_id=NULL,agent_number=NULL,recording_url=NULL,transcript=NULL,transcript_data=NULL,
    transcript_recording_url=NULL,summary=NULL,action_items=NULL,key_points=NULL,next_moves=NULL,followups=NULL,error=NULL,
    agreements=NULL,conflicts=NULL,recap=NULL,
    language=NULL,language_probability=NULL,processing_token=NULL,processing_until=NULL,
    recording_lookup_token=NULL,recording_lookup_until=NULL,
    twilio_account_sid=$3,provider_deletion_status=$2,provider_deletion_error=NULL,
    provider_deleted_at=CASE WHEN $2='confirmed' THEN now() ELSE NULL END,
    storage_deletion_status=CASE WHEN audio_object_key IS NOT NULL THEN 'pending' ELSE 'not_required' END
    WHERE id=$1 RETURNING *`,
  [current.id, providerStatus, recordingAccount(current)]);
  await tx.query('DELETE FROM followup_events WHERE call_id=$1', [current.id]);
  await tx.query('DELETE FROM promise_states WHERE call_id=$1', [current.id]);
  await tx.query('DELETE FROM call_notifications WHERE call_id=$1', [current.id]);
  await tx.query("UPDATE calendar_actions SET meeting='{}'::jsonb WHERE call_id=$1", [current.id]);
  await tx.query("UPDATE email_actions SET email='{}'::jsonb WHERE call_id=$1", [current.id]);
  return deleted;
}

export const needsDeletionWork = call =>
  ['pending','unknown'].includes(call.provider_deletion_status) || ['pending','unknown'].includes(call.storage_deletion_status);
