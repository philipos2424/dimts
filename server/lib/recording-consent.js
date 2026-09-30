import { config } from '../config.js';

export function askRecordingConsent(twiml, action) {
  twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 15, method: 'POST', action })
    .say('This call will be recorded and transcribed for notes. Press 1 to agree and connect. Otherwise hang up.');
  twiml.say('No agreement received. Goodbye.');
  twiml.hangup();
}

export function dialCall(twiml, call) {
  const base = config.publicBaseUrl;
  const recording = call.record_enabled !== false && Boolean(call.id);
  const dial = twiml.dial({
    ...(recording ? { record: 'record-from-answer-dual',
      recordingStatusCallback: `${base}/webhooks/recording-ready?callId=${call.id}`,
      recordingStatusCallbackMethod: 'POST', recordingStatusCallbackEvent: 'completed' } : {}),
    answerOnBridge: true,
    action: `${base}/twiml/dial-done?callId=${call.id}`, method: 'POST', timeout: 30,
    timeLimit: call.max_duration_sec ?? 1800,
    ...(call.direction === 'inbound' ? { callerId: config.twilioNumber } : {}),
  });
  const target = call.direction === 'inbound' ? call.user_phone : call.destination;
  dial.number(recording ? { url: `${base}/twiml/party-consent?callId=${call.id}`, method: 'POST' } : {}, target);
}
