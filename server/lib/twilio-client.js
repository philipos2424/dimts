import twilio from 'twilio';
import { config } from '../config.js';

/**
 * REST credentials for Twilio. An API key is preferred: it can be revoked on
 * its own, whereas rotating the auth token breaks every integration at once.
 * The auth token is still required for webhook signature validation.
 */
function apiKey() {
  const sid = process.env.TWILIO_API_KEY_SID, secret = process.env.TWILIO_API_KEY_SECRET;
  if (!sid && !secret) return null;
  if (!/^SK[0-9a-f]{32}$/.test(sid ?? '') || !secret) {
    throw new Error('TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must be set together');
  }
  return { sid, secret };
}

export function twilioClient(options = {}, account = config.twilioAccountSid) {
  const key = apiKey();
  return key ? twilio(key.sid, key.secret, { ...options, accountSid: account }) : twilio(account, config.twilioAuthToken, options);
}

/** Basic auth header value for direct media fetches. */
export function twilioBasicAuth() {
  const key = apiKey();
  const [user, password] = key ? [key.sid, key.secret] : [config.twilioAccountSid, config.twilioAuthToken];
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}
