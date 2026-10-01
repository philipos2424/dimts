import { config } from '../config.js';

export function askRecordingConsent(twiml, action) {
  twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 15, method: 'POST', action, actionOnEmptyResult: true })
    .say('This call can be recorded and transcribed for notes, only if both people agree. Press 1 to agree, or press 2 to connect without recording. No response means no recording.');
  twiml.say('We could not receive your choice. Goodbye.');
  twiml.hangup();
}

export function dialCall(twiml, call) {
  const base = config.publicBaseUrl;
  const dial = twiml.dial({
    // Recording starts through the REST API only after both choices are saved.
    record: 'do-not-record',
    answerOnBridge: true,
    action: `${base}/twiml/dial-done?callId=${call.id}`, method: 'POST', timeout: 30,
    timeLimit: call.max_duration_sec ?? 1800,
    callerId: call.agent_number || config.twilioNumber,
  });
  const target = call.direction === 'inbound' ? call.user_phone : call.destination;
  dial.number({ url: `${base}/twiml/party-consent?callId=${call.id}`, method: 'POST' }, target);
}
