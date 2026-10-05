import express from 'express';
import twilio from 'twilio';
import { findUserByAgentNumber } from '../db/agent-numbers.js';
import { findOrCreateContact } from '../db/contacts.js';
import { reserveCall } from '../db/reserve-call.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';
import { askRecordingConsent, dialCall, issueRecordingNotice } from '../lib/recording-consent.js';
import { queryOne } from '../db/pool.js';
import { config } from '../config.js';
import { sendIncomingNotification } from '../services/notifications.js';
import { defer } from '../lib/defer.js';
import { safeError } from '../lib/log-safe.js';

const { VoiceResponse } = twilio.twiml;

export const inboundRouter = express.Router();
inboundRouter.use(verifyTwilioSignature);

/**
 * Best-effort contact resolution.
 *
 * A failure here costs us the contact link on this call - it must never cost
 * the user the call itself, so it resolves to null instead of throwing.
 */
async function resolveContact(userId, callerNumber) {
  try {
    const contact = await findOrCreateContact(userId, callerNumber);
    return contact?.id ?? null;
  } catch (err) {
    console.error('[inbound] contact lookup failed', safeError(err));
    return null;
  }
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

  const contactId = await resolveContact(user.id, caller);

  let call;
  try {
    if (!CallSid || !caller || caller === agentNumber || caller === user.phone) throw new Error('Invalid incoming call');
    ({ call } = await reserveCall(user, caller, true, `incoming-${CallSid}`, { direction: 'inbound', callSid: CallSid, contactId }));
  } catch (err) {
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
