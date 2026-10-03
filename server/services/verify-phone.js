import { twilioClient } from '../lib/twilio-client.js';
import { telnyxRequest } from '../lib/telnyx-rest.js';
import { config } from '../config.js';
import { HttpError } from '../lib/users.js';

function service() {
  return twilioClient({ timeout: 15_000 })
    .verify.v2.services(config.twilioVerifyServiceSid);
}

// Some carriers (Ethio Telecom among them) filter international SMS codes; a
// voice call reading the code out is the fallback.
export async function sendPhoneCode(phone, channel = 'sms') {
  if (config.carrier === 'telnyx') return sendTelnyxCode(phone, channel);
  try { await service().verifications.create({ to: phone, channel }); }
  catch (err) {
    if (err.code === 21608) throw new HttpError(403, 'verification_trial_number_required',
      'This pilot uses a Twilio trial account. Verify this mobile number in Twilio first, or use a verified test number.');
    if (err.code === 60605) throw new HttpError(403, 'verification_country_disabled',
      'Verification messages are not enabled for this country. The operator needs to check Twilio Verify geographic permissions.');
    throw err;
  }
}

export async function checkPhoneCode(phone, code) {
  if (config.carrier === 'telnyx') return checkTelnyxCode(phone, code);
  try {
    const result = await service().verificationChecks.create({ to: phone, code });
    return result.status === 'approved';
  } catch (err) {
    if ([20404, 60202, 60203].includes(err.code)) return false;
    throw err;
  }
}

async function sendTelnyxCode(phone, channel) {
  try {
    await telnyxRequest('POST', `/verifications/${channel === 'call' ? 'call' : 'sms'}`, {
      json: { phone_number: phone, verify_profile_id: config.telnyxVerifyProfileId }, timeout: 15_000,
    });
  } catch (err) {
    // A destination outside the Verify profile's allowed countries.
    if (err.status === 422 || err.status === 403) throw new HttpError(403, 'verification_country_disabled',
      'Verification messages are not enabled for this country. The operator needs to check the Telnyx Verify profile.');
    throw err;
  }
}

async function checkTelnyxCode(phone, code) {
  try {
    const result = await telnyxRequest('POST', `/verifications/by_phone_number/${encodeURIComponent(phone)}/actions/verify`, {
      json: { code, verify_profile_id: config.telnyxVerifyProfileId }, timeout: 15_000,
    });
    return result?.responseCode === 'accepted';
  } catch (err) {
    // No pending verification for this number, or it already expired.
    if (err.status === 404 || err.status === 422) return false;
    throw err;
  }
}
