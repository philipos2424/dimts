import { config } from '../config.js';
import { isE164 } from './phone.js';

export function askRecordingConsent(twiml, action, ownerOnly = false) {
  twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 15, method: 'POST', action, actionOnEmptyResult: true })
    .say(ownerOnly
      ? 'You can record and transcribe this call for your notes. The other person will hear a recording notice. Press 1 to agree, or press 2 to connect without recording. No response means no recording.'
      : 'This call can be recorded and transcribed for notes, only if both people agree. Press 1 to agree, or press 2 to connect without recording. No response means no recording.');
  // TeXML has no actionOnEmptyResult: an empty Gather falls through, so send
  // "no response" to the same action, which connects without recording.
  if (config.carrier === 'telnyx') { twiml.redirect({ method: 'POST' }, action); return; }
  twiml.say('We could not receive your choice. Goodbye.');
  twiml.hangup();
}

/**
 * On Telnyx, notice calls record through <Dial> itself: the dialled leg's
 * instructions may only hold <Gather>/<Hangup>, and an empty Gather never calls
 * back, so the REST "record after notice" step cannot run there. Recording
 * starts when the dialled phone answers; the two people are only connected
 * after the notice has played, so no conversation precedes it.
 */
export const recordsThroughDial = call =>
  config.carrier === 'telnyx' && call.record_enabled !== false && call.consent_mode === 'notice';

// Legal text: a constant, never configuration, so it cannot drift between deployments.
export const RECORDING_NOTICE = 'This call is recorded and summarized by Dimts AI.';

export function issueRecordingNotice(twiml) {
  twiml.say(RECORDING_NOTICE);
}

export function dialCall(twiml, call) {
  const base = config.publicBaseUrl;
  const dial = twiml.dial({
    // Recording starts through the REST API after this call's policy is met,
    // except notice calls on Telnyx (see recordsThroughDial).
    ...(recordsThroughDial(call) ? {
      record: 'record-from-answer-dual', recordingChannels: 'dual',
      recordingStatusCallback: `${base}/webhooks/recording-ready?callId=${call.id}`,
      recordingStatusCallbackMethod: 'POST', recordingStatusCallbackEvent: 'completed',
    } : { record: 'do-not-record' }),
    answerOnBridge: true,
    action: `${base}/twiml/dial-done?callId=${call.id}`, method: 'POST', timeout: 30,
    timeLimit: call.max_duration_sec ?? 1800,
    // On incoming calls the owner sees who is calling, not the Dimts number.
    // Twilio allows passing the original caller's number through when forwarding.
    // Outgoing: the owner's verified mobile when they chose it, so people see who is calling.
    callerId: call.direction === 'inbound' && isE164(call.destination) ? call.destination
      : call.direction === 'outbound' && isE164(call.caller_id) ? call.caller_id
      : call.agent_number || config.twilioNumber,
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
    maxLength: VOICEMAIL_MAX_SECONDS, playBeep: true, trim: 'trim-silence',
    // Telnyx detects silence by transcribing (billed) and records dual by default.
    ...(config.carrier === 'telnyx' ? { channels: 'single' } : { timeout: 5 }),
    action: `${base}/twiml/voicemail-done?callId=${call.id}`, method: 'POST',
    recordingStatusCallback: `${base}/webhooks/recording-ready?callId=${call.id}`,
    recordingStatusCallbackMethod: 'POST', recordingStatusCallbackEvent: ['completed'],
  });
  twiml.hangup();
}

