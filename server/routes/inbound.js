import express from 'express';
import twilio from 'twilio';
import { findUserByAgentNumber } from '../db/agent-numbers.js';
import { findOrCreateContact } from '../db/contacts.js';
import { reserveCall } from '../db/reserve-call.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';
import { askRecordingConsent, dialCall, issueRecordingNotice, offerVoicemail } from '../lib/recording-consent.js';
import { sendMissedForBalanceAlert } from '../services/billing-alerts.js';
import { queryOne } from '../db/pool.js';
import { config } from '../config.js';
import { sendIncomingNotification } from '../services/notifications.js';
import { defer } from '../lib/defer.js';
import { shouldRecordIncoming } from '../lib/incoming-recording.js';
import { safeError } from '../lib/log-safe.js';

const { VoiceResponse } = twilio.twiml;

export const inboundRouter = express.Router();
inboundRouter.use(verifyTwilioSignature);

/**
 * Best-effort contact resolution.
 *
 * A failure here costs us the contact link on this call - it must never cost
 * the user the call itself, so it resolves to null instead of throwing
 * (and the owner's default recording choice applies).
 */
async function resolveContact(userId, callerNumber) {
  try {
    return (await findOrCreateContact(userId, callerNumber)) ?? null;
  } catch (err) {
    console.error('[inbound] contact lookup failed', safeError(err));
    return null;
  }
}

/**
 * Send the caller straight to voicemail, recorded with the usual notice, and
 * tell the owner why. Returns false when the message cannot be recorded.
 */
async function takeMessage(user, caller, callSid, contactId, twiml) {
  const { call } = await reserveCall(user, caller, true, `incoming-${callSid}`,
    { direction: 'inbound', callSid, contactId, voicemailOnly: true });
  if (!call.voicemail || call.record_enabled === false || call.consent_mode !== 'notice') return false;
  const announced = await queryOne(`UPDATE calls SET other_party_notice_issued_at=COALESCE(other_party_notice_issued_at,now())
    WHERE id=$1 AND twilio_call_sid=$2 RETURNING *`, [call.id, callSid]);
  if (!announced) return false;
  issueRecordingNotice(twiml);
  offerVoicemail(twiml, announced);
  defer(sendMissedForBalanceAlert(user.id), `missed-balance:${user.id}`);
  return true;
}

/** Twilio fetches this when someone dials a user's published agent number. */
inboundRouter.post('/', async (req, res) => {
  const { From: caller, To: agentNumber, CallSid } = req.body ?? {};
  const twiml = new VoiceResponse();

  const user = await findUserByAgentNumber(agentNumber).catch((err) => {
    console.error('[inbound] owner lookup failed', safeError(err));
    return undefined;
  });

  if (!user) {
    twiml.say('This number is not in service.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const contact = await resolveContact(user.id, caller);
  const contactId = contact?.id ?? null;

  let call;
  try {
    if (!CallSid || !caller || caller === agentNumber || caller === user.phone) throw new Error('Invalid incoming call');
    ({ call } = await reserveCall(user, caller, shouldRecordIncoming(user, contact), `incoming-${CallSid}`, { direction: 'inbound', callSid: CallSid, contactId }));
  } catch (err) {
    if (['number_not_in_service', 'account_not_found'].includes(err?.code)) {
      twiml.say('This number is not in service.');
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }
    // Out of minutes and credits: a business line should still take a message.
    if (['credits_required', 'call_minutes_limit'].includes(err?.code)) {
      const message = await takeMessage(user, caller, CallSid, contactId, twiml).catch(fallback => {
        console.error('[inbound] voicemail fallback failed', safeError(fallback));
        return false;
      });
      if (message) return res.type('text/xml').send(twiml.toString());
    }
    console.error('[inbound] call reservation refused', safeError(err));
    twiml.say('We cannot connect this call right now. Please try again later.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (['ringing','in-progress'].includes(call.status)) defer(sendIncomingNotification(call.id), `incoming-notification:${call.id}`);
  if (['initiating', 'ringing'].includes(call.status)) {
    // The caller hears the notice before the owner's phone rings. An unrecorded
    // call (owner has not accepted terms) connects without one.
    if (call.record_enabled !== false && call.consent_mode === 'notice') {
      const announced = await queryOne(`UPDATE calls SET other_party_notice_issued_at=COALESCE(other_party_notice_issued_at,now())
        WHERE id=$1 AND twilio_call_sid=$2 AND duration_sec IS NULL RETURNING *`, [call.id, CallSid]);
      if (!announced) twiml.hangup();
      else { issueRecordingNotice(twiml); dialCall(twiml, announced); }
    } else if (call.record_enabled !== false && call.consent_mode === 'all_parties') {
      // The caller agrees first; the owner is asked on their own leg before recording starts.
      askRecordingConsent(twiml, `${config.publicBaseUrl}/twiml/accept?callId=${call.id}`);
    } else dialCall(twiml, call);
  }
  else twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});
