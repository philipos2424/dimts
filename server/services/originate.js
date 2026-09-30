import twilio from 'twilio';
import { config } from '../config.js';

// Single source of truth lives in lib/phone.js; re-exported so existing
// importers of this module keep working.
export { isE164 } from '../lib/phone.js';

let client;
function getClient() {
  if (!client) {
    client = twilio(config.twilioAccountSid, config.twilioAuthToken, { timeout: 15_000, autoRetry: false });
  }
  return client;
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
export async function originateCall({ callId, userPhone, destination, agentNumber }) {
  const base = config.publicBaseUrl;
  const params = new URLSearchParams({ callId, dest: destination });

  const call = await getClient().calls.create({
    to: userPhone,
    from: agentNumber || config.twilioNumber,
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
  const url = new URL(recordingUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com' || url.username || url.password ||
      !url.pathname.startsWith(`/2010-04-01/Accounts/${config.twilioAccountSid}/Recordings/`)) {
    throw new Error('Untrusted recording URL');
  }
  if (![1, 2].includes(channels)) throw new Error('Invalid recording channel count');
  url.pathname = `${url.pathname.replace(/\.(mp3|wav)$/, '')}.mp3`;
  url.search = new URLSearchParams({ RequestedChannels: String(channels) }).toString();
  const auth = Buffer.from(
    `${config.twilioAccountSid}:${config.twilioAuthToken}`
  ).toString('base64');

  return fetch(url, { headers: { Authorization: `Basic ${auth}` },
    redirect: 'error', signal: AbortSignal.timeout(30_000) });
}
