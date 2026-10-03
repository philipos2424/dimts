import { config } from '../config.js';
import { isE164 } from './phone.js';

export function askRecordingConsent(twiml, action, ownerOnly = false) {
  twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 15, method: 'POST', action, actionOnEmptyResult: true })
    .say(ownerOnly
      ? 'You can record and transcribe this call for your notes. The other person will hear a recording notice. Press 1 to agree, or press 2 to connect without recording. No response means no recording.'
      : 'This call can be recorded and transcribed for notes, only if both people agree. Press 1 to agree, or press 2 to connect without recording. No response means no recording.');
  twiml.say('We could not receive your choice. Goodbye.');
  twiml.hangup();
}

// Legal text: a constant, never configuration, so it cannot drift between deployments.
export const RECORDING_NOTICE = 'This call is recorded and summarized by Dimts AI.';

export function issueRecordingNotice(twiml) {
  twiml.say(RECORDING_NOTICE);
}

export function dialCall(twiml, call) {
  const base = config.publicBaseUrl;
  const dial = twiml.dial({
    // Recording starts through the REST API after this call's policy is met.
    record: 'do-not-record',
    answerOnBridge: true,
    action: `${base}/twiml/dial-done?callId=${call.id}`, method: 'POST', timeout: 30,
    timeLimit: call.max_duration_sec ?? 1800,
    // On incoming calls the owner sees who is calling, not the Dimts number.
    // Twilio allows passing the original caller's number through when forwarding.
    callerId: call.direction === 'inbound' && isE164(call.destination) ? call.destination : call.agent_number || config.twilioNumber,
  });
  const target = call.direction === 'inbound' ? call.user_phone : call.destination;
  dial.number({ url: `${base}/twiml/party-consent?callId=${call.id}`, method: 'POST' }, target);
}

export const VOICEMAIL_MAX_SECONDS = 120;

/** Offered when the owner misses an incoming call the caller agreed could be recorded. */
export function offerVoicemail(twiml, call) {
  const base = config.publicBaseUrl;
  twiml.say('Sorry, they could not answer. Leave a message after the tone, and they will see it in Dimts.');
  twiml.record({
    maxLength: VOICEMAIL_MAX_SECONDS, playBeep: true, timeout: 5, trim: 'trim-silence',
    action: `${base}/twiml/voicemail-done?callId=${call.id}`, method: 'POST',
    recordingStatusCallback: `${base}/webhooks/recording-ready?callId=${call.id}`,
    recordingStatusCallbackMethod: 'POST', recordingStatusCallbackEvent: ['completed'],
  });
  twiml.hangup();
}

