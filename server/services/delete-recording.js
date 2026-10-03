import { twilioClient } from '../lib/twilio-client.js';
import { config } from '../config.js';
import { isTwilioAccount } from '../lib/recording-account.js';

// Only delete a verified recording belonging to this account and parent call.
// A timeout is uncertain; callers retain the job so a later retry can check
// absence before attempting deletion again. Never accept provider URLs as input.
export async function deleteProviderRecording(call) {
  const account = config.twilioAccountSid;
  if (!/^AC[a-f0-9]{32}$/i.test(account) || !/^CA[a-f0-9]{32}$/i.test(call.twilio_call_sid ?? '') ||
      (call.recording_sid && !/^RE[a-f0-9]{32}$/i.test(call.recording_sid))) return { status: 'unknown', error: 'invalid_reference' };
  if (!isTwilioAccount(call.twilio_account_sid)) return { status: 'unknown', error: 'account_unverified' };
  if (call.twilio_account_sid !== account) return { status: 'unknown', error: 'account_changed' };
  // Capture both current credentials for this operation; a cached client could
  // silently retain the old account or token after configuration changes.
  const client = twilioClient({ timeout: 10_000, autoRetry: false }, account);
  let recording;
  try {
    if (call.recording_sid) {
      try { recording = await client.recordings(call.recording_sid).fetch(); }
      catch (err) { if (err.status === 404) return { status: 'confirmed' }; throw err; }
    } else {
      const recordings = await client.calls(call.twilio_call_sid).recordings.list({ limit: 2, pageSize: 2 });
      if (!recordings.length) return { status: 'confirmed' };
      if (recordings.length !== 1) return { status: 'unknown', error: 'multiple_recordings' };
      recording = recordings[0];
    }
    if (recording.accountSid !== account || recording.callSid !== call.twilio_call_sid ||
        !/^RE[a-f0-9]{32}$/i.test(recording.sid ?? '') || (call.recording_sid && recording.sid !== call.recording_sid)) {
      return { status: 'unknown', error: 'owner_mismatch' };
    }
    if (recording.status === 'deleted') return { status: 'confirmed' };
    if (recording.status !== 'completed') return { status: 'unknown', error: 'recording_unfinished' };
    const resource = client.recordings(recording.sid);
    try { await resource.remove(); }
    catch (err) { if (err.status !== 404) throw err; }
    // An independent read verifies absence rather than trusting a delete
    // response when the provider request or its result storage was interrupted.
    try {
      const receipt = await resource.fetch();
      if (receipt.accountSid !== account || receipt.callSid !== call.twilio_call_sid || receipt.sid !== recording.sid) return { status: 'unknown', error: 'owner_mismatch' };
      return receipt.status === 'deleted' ? { status: 'confirmed' } : { status: 'unknown', error: 'still_present' };
    }
    catch (err) { if (err.status === 404) return { status: 'confirmed' }; throw err; }
  } catch { return { status: 'unknown', error: 'provider_unavailable' }; }
}
