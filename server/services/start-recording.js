import { twilioClient } from '../lib/twilio-client.js';
import { config } from '../config.js';
let client;
export async function startCallRecording(call) {
  if (!/^CA[a-f0-9]{32}$/i.test(call.twilio_call_sid ?? '')) throw Object.assign(new Error('Invalid parent call'), { status: 400 });
  client ??= twilioClient({ timeout: 5000, autoRetry: false });
  const recording = await client.calls(call.twilio_call_sid).recordings.create({
    recordingChannels: 'dual', recordingTrack: 'both',
    recordingStatusCallback: `${config.publicBaseUrl}/webhooks/recording-ready?callId=${call.id}`,
    recordingStatusCallbackMethod: 'POST', recordingStatusCallbackEvent: ['completed'],
  });
  if (!/^RE[a-f0-9]{32}$/i.test(recording.sid ?? '')) throw new Error('Invalid recording receipt');
  return recording.sid;
}
