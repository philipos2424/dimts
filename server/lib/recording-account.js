import { isAccountSid } from './carrier.js';

export function isTwilioAccount(value) {
  return typeof value === 'string' && /^AC[a-f0-9]{32}$/i.test(value);
}

// Legacy calls may predate account stamping. Extract only from a canonical
// provider reference before deleting that URL; never assume today's account.
export function recordingAccount(call) {
  // Telnyx calls are always stamped with their account when reserved.
  if (call.twilio_account_sid != null && !isTwilioAccount(call.twilio_account_sid)) return isAccountSid(call.twilio_account_sid) ? call.twilio_account_sid : null;
  let fromUrl;
  try {
    const url = new URL(call.recording_url);
    if (url.protocol === 'https:' && url.hostname === 'api.twilio.com' &&
        !url.username && !url.password && !url.port && !url.search && !url.hash) {
      const match = /^\/2010-04-01\/Accounts\/(AC[a-f0-9]{32})\/Recordings\/(RE[a-f0-9]{32})(?:\.(?:mp3|wav))?$/i.exec(url.pathname);
      if (match) {
        if (call.recording_sid && call.recording_sid !== match[2]) return null;
        fromUrl = match[1];
      }
    }
  } catch { /* Missing or noncanonical legacy reference does not prove ownership. */ }
  if (fromUrl && call.twilio_account_sid && fromUrl !== call.twilio_account_sid) return null;
  return call.twilio_account_sid ?? fromUrl ?? null;
}
