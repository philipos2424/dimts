import { query, queryOne } from '../db/pool.js';
import { transcriptTurns } from '../lib/transcript-turns.js';

// Explicit column lists only: an export must never pick up a token, a hash or
// a provider URL just because someone added a column later.
export async function buildExport(userId) {
  const profile = await queryOne(`SELECT phone,tier,agent_number,created_at,terms_version,terms_accepted_at,language,retention_months
    FROM users WHERE id=$1`, [userId]);
  const calls = (await query(`SELECT id,created_at,completed_at,direction,destination,contact_id,status,duration_sec,
      language,transcript,summary,key_points,action_items,next_moves,followups,agreements,conflicts,
      recording_url,transcript_recording_url,transcript_data,deleted_at,audio_object_key
    FROM calls WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at`, [userId])).rows
    .map(({ recording_url, transcript_recording_url, transcript_data, deleted_at, audio_object_key, ...call }) => ({
      ...call,
      transcript_turns: transcriptTurns({ ...call, recording_url, transcript_recording_url, transcript_data, deleted_at }),
      audio_path: recording_url || audio_object_key ? `/api/calls/${call.id}/audio` : null,
    }));
  const contacts = (await query(`SELECT id,phone,display_name,company,name_source,notes,first_seen_at,last_call_at
    FROM contacts WHERE user_id=$1 ORDER BY first_seen_at`, [userId])).rows;
  const google = (await query('SELECT kind,connected_at FROM google_connections WHERE user_id=$1 ORDER BY kind', [userId])).rows;
  const calendar = (await query('SELECT id,call_id,status,created_at FROM calendar_actions WHERE user_id=$1 ORDER BY created_at', [userId])).rows;
  const email = (await query('SELECT id,call_id,status,created_at FROM email_actions WHERE user_id=$1 ORDER BY created_at', [userId])).rows;
  const deletions = (await query(`SELECT id,deleted_at,provider_deletion_status,storage_deletion_status
    FROM calls WHERE user_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at`, [userId])).rows;
  const promiseStates = (await query(`SELECT p.call_id,p.item_index,p.status,p.updated_at FROM promise_states p
    JOIN calls c ON c.id=p.call_id WHERE c.user_id=$1 ORDER BY p.updated_at`, [userId])).rows;
  const auditEvents = (await query(`SELECT action,target_type,target_id,reason,created_at FROM audit_events
    WHERE user_id=$1 ORDER BY created_at, id`, [userId])).rows;
  return {
    format: 'dimts-export-v1',
    exported_at: new Date().toISOString(),
    README: 'Everything Dimts holds about your account. Audio for each call is downloadable at its audio_path while signed in.',
    profile, calls, contacts, google_connections: google,
    calendar_actions: calendar, email_actions: email, deletions, promise_states: promiseStates, audit_events: auditEvents,
  };
}
