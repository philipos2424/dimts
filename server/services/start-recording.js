import { isCallSid, isRecordingSid, providerRest } from '../lib/carrier.js';
import { config } from '../config.js';
export async function startCallRecording(call) {
  if (!isCallSid(call.twilio_call_sid)) throw Object.assign(new Error('Invalid parent call'), { status: 400 });
  const client = providerRest({ timeout: 5000, autoRetry: false });
  const recording = await client.calls(call.twilio_call_sid).recordings.create({
    recordingChannels: 'dual', recordingTrack: 'both',
    recordingStatusCallback: `${config.publicBaseUrl}/webhooks/recording-ready?callId=${call.id}`,
    recordingStatusCallbackMethod: 'POST', recordingStatusCallbackEvent: ['completed'],
  });
  if (!isRecordingSid(recording.sid)) throw new Error('Invalid recording receipt');
  return recording.sid;
}
