import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { findUserByAgentNumber } from '../db/agent-numbers.js';
import { findOrCreateContact } from '../db/contacts.js';
import { reserveCall } from '../db/reserve-call.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';
import { askRecordingConsent } from '../lib/recording-consent.js';
import { sendIncomingNotification } from '../services/notifications.js';
import { defer } from '../lib/defer.js';

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
    console.error('[inbound] contact lookup failed', err);
    return null;
  }
}

/** Twilio fetches this when someone dials a user's published agent number. */
inboundRouter.post('/', async (req, res) => {
  const { From: caller, To: agentNumber, CallSid } = req.body ?? {};
  const twiml = new VoiceResponse();

  const user = await findUserByAgentNumber(agentNumber).catch((err) => {
    console.error('[inbound] owner lookup failed', err);
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
    console.error('[inbound] call reservation refused', err);
    twiml.say('We cannot connect this call right now. Please try again later.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const base = config.publicBaseUrl;
  if (['ringing','in-progress'].includes(call.status)) defer(sendIncomingNotification(call.id), `incoming-notification:${call.id}`);
  if (['initiating', 'ringing'].includes(call.status)) askRecordingConsent(twiml, `${base}/twiml/accept?callId=${call.id}`);
  else twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});
