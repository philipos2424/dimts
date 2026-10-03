import { twilioBasicAuth } from '../lib/twilio-client.js';
import { isAccountSid, isRecordingSid, providerRest } from '../lib/carrier.js';
import { config } from '../config.js';

// Single source of truth lives in lib/phone.js; re-exported so existing
// importers of this module keep working.
export { isE164 } from '../lib/phone.js';

const getClient = () => providerRest({ timeout: 15_000, autoRetry: false });

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
    // Twilio names the instruction method `method`; TeXML calls it `UrlMethod`.
    ...(config.carrier === 'telnyx' ? { urlMethod: 'POST' } : { method: 'POST' }),
    statusCallback: `${base}/webhooks/call-status?callId=${callId}`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });

  return call.sid ?? null;
}

/**
 * Streams recording media back to the caller. Twilio serves it only once the
 * recording is `completed`, and briefly 404s right after the webhook fires.
 */
export async function fetchRecording(recordingUrl, { channels = 2, range, signal, recordingSid } = {}) {
  if (range && (range.length > 64 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) throw new Error('Invalid audio range');
  if (config.carrier === 'telnyx') return fetchTelnyxRecording(recordingUrl, { range, signal, recordingSid });
  const url = new URL(recordingUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com' || url.username || url.password ||
      !url.pathname.startsWith(`/2010-04-01/Accounts/${config.twilioAccountSid}/Recordings/`)) {
    throw new Error('Untrusted recording URL');
  }
  if (![1, 2].includes(channels)) throw new Error('Invalid recording channel count');
  url.pathname = `${url.pathname.replace(/\.(mp3|wav)$/, '')}.mp3`;
  url.search = new URLSearchParams({ RequestedChannels: String(channels) }).toString();
  return fetch(url, { headers: { Authorization: twilioBasicAuth(), ...(range ? { Range: range } : {}) },
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
}

/**
 * Telnyx serves recordings from short-lived signed links. With the recording
 * SID, ask the API for a fresh link owned by this account; the link from the
 * webhook is only used before the SID is known. Channel layout is fixed when
 * the recording is made, so `channels` does not apply.
 */
async function fetchTelnyxRecording(recordingUrl, { range, signal, recordingSid }) {
  let media = recordingUrl;
  if (isRecordingSid(recordingSid)) {
    const recording = await providerRest({ timeout: 10_000 }).recordings(recordingSid).fetch();
    if (!isAccountSid(recording?.accountSid) || recording.accountSid !== config.providerAccountSid || recording.sid !== recordingSid) {
      throw new Error('Recording owner mismatch');
    }
    media = recording.mediaUrl;
  }
  const url = new URL(media);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Untrusted recording URL');
  const headers = { ...(range ? { Range: range } : {}) };
  if (url.hostname === 'api.telnyx.com') headers.Authorization = `Bearer ${config.telnyxApiKey}`;
  return fetch(url, { headers, redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
}
