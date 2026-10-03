import { config } from '../config.js';
import { twilioClient } from './twilio-client.js';
import { telnyxRest } from './telnyx-rest.js';

/**
 * One switch between Twilio and Telnyx. Both speak the same call markup and
 * Twilio-shaped REST resources; what differs is the identifier formats, the
 * credentials and where recording audio is fetched from.
 */
const FORMATS = {
  twilio: {
    account: /^AC[a-f0-9]{32}$/i,
    call: /^CA[a-f0-9]{32}$/i,
    recording: /^RE[a-f0-9]{32}$/i,
  },
  telnyx: {
    account: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    // call_control_id, e.g. v3:9X2vxPDFY2RHSJ1EdMS0RHRksMTg7ldNxdjWbVr9zBjbGjGsSe-aiQ
    call: /^v\d+:[A-Za-z0-9_-]{10,200}$/,
    recording: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
};

const formats = () => FORMATS[config.carrier];
const test = (pattern, value) => typeof value === 'string' && pattern.test(value);

export const isAccountSid = value => test(formats().account, value);
export const isCallSid = value => test(formats().call, value);
export const isRecordingSid = value => test(formats().recording, value);

/** A Twilio-shaped REST client for the active carrier. */
export function providerRest(options = {}, account = config.providerAccountSid) {
  return config.carrier === 'telnyx' ? telnyxRest(options, account) : twilioClient(options, account);
}
