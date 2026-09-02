import twilio from 'twilio';
import { config } from '../config.js';

let client;
function getClient() {
  if (!client) {
    client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  }
  return client;
}

/** Twilio's E.164 requirement, checked before we spend money on a call. */
export function isE164(value) {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
}

/**
 * Leg A of the dial-through: ring the user's own handset. When they answer,
 * Twilio fetches /twiml/bridge, which dials the destination as leg B and
 * records both channels.
 *
 * This is the single most expensive line in the product (leg A is a billed
 * PSTN call — see the plan's cost analysis) and the seam where a Twilio Voice
 * SDK connection would replace the PSTN leg later. Nothing outside this module
 * should know how leg A is established.
 */
export async function originateCall({ callId, userPhone, destination }) {
  const base = config.publicBaseUrl;
  const params = new URLSearchParams({ callId, dest: destination });

  const call = await getClient().calls.create({
    to: userPhone,
    from: config.twilioNumber,
    url: `${base}/twiml/bridge?${params}`,
    method: 'POST',
    statusCallback: `${base}/webhooks/call-status?callId=${callId}`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });

  return call.sid;
}

/**
 * Streams recording media back to the caller. Twilio serves it only once the
 * recording is `completed`, and briefly 404s right after the webhook fires.
 */
export async function fetchRecording(recordingUrl, { channels = 2 } = {}) {
  const auth = Buffer.from(
    `${config.twilioAccountSid}:${config.twilioAuthToken}`
  ).toString('base64');

  const url = `${recordingUrl}.mp3?RequestedChannels=${channels}`;
  return fetch(url, { headers: { Authorization: `Basic ${auth}` } });
}
