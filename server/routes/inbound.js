import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { findUserByAgentNumber } from '../db/agent-numbers.js';
import { findOrCreateContact } from '../db/contacts.js';
import { queryOne } from '../db/pool.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';
import { askRecordingConsent, dialCall } from '../lib/recording-consent.js';

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

  let callId = null;
  try {
    const row = await queryOne(
      `INSERT INTO calls (user_id, user_phone, destination, twilio_call_sid,
                          contact_id, direction, status)
       VALUES ($1, $2, $3, $4, $5, 'inbound', 'ringing')
       RETURNING id`,
      [user.id, user.phone, caller, CallSid, contactId]
    );
    callId = row?.id ?? null;
  } catch (err) {
    // Losing the row means losing the notes, not the conversation.
    console.error('[inbound] could not create call row', err);
  }

  const base = config.publicBaseUrl;
  if (callId) askRecordingConsent(twiml, `${base}/twiml/accept?callId=${callId}`);
  else dialCall(twiml, { id: null, direction: 'inbound', user_phone: user.phone, record_enabled: false });

  res.type('text/xml').send(twiml.toString());
});
