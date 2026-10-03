import { twilioClient } from '../lib/twilio-client.js';
import { config } from '../config.js';
let client;

// Read-only recovery. Never create a recording or guess which of multiple
// recordings is the conversation the user expects.
export async function findCompletedRecording(call) {
  const account = config.twilioAccountSid;
  if (!/^AC[a-f0-9]{32}$/i.test(account) || !/^CA[a-f0-9]{32}$/i.test(call.twilio_call_sid ?? '') ||
    (call.recording_sid && !/^RE[a-f0-9]{32}$/i.test(call.recording_sid))) throw new Error('Invalid recording reference');
  client ??= twilioClient({ timeout: 10_000, autoRetry: false }, account);
  let recordings;
  if (call.recording_sid) {
    try { recordings = [await client.recordings(call.recording_sid).fetch()]; }
    catch (err) { if (err.status === 404) return { status: 'unavailable' }; throw err; }
  } else recordings = await client.calls(call.twilio_call_sid).recordings.list({ limit: 2, pageSize: 2 });
  if (!recordings.length) return { status: 'unavailable' };
  if (recordings.length !== 1) return { status: 'ambiguous' };
  const recording = recordings[0];
  if (recording.accountSid !== account || recording.callSid !== call.twilio_call_sid ||
    !/^RE[a-f0-9]{32}$/i.test(recording.sid ?? '') || (call.recording_sid && recording.sid !== call.recording_sid)) {
    throw new Error('Recording owner mismatch');
  }
  if (recording.status !== 'completed') return { status: 'unavailable' };
  const seconds = Number(recording.duration);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || Number(recording.channels) !== 2) return { status: 'unsupported' };
  return { status: 'found', sid: recording.sid,
    url: `https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${recording.sid}` };
}
