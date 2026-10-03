import { twilioClient } from '../lib/twilio-client.js';
import { config } from '../config.js';
import { HttpError } from '../lib/users.js';

function service() {
  return twilioClient({ timeout: 15_000 })
    .verify.v2.services(config.twilioVerifyServiceSid);
}

// Some carriers (Ethio Telecom among them) filter international SMS codes; a
// voice call reading the code out is the fallback.
export async function sendPhoneCode(phone, channel = 'sms') {
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
  try {
    const result = await service().verificationChecks.create({ to: phone, code });
    return result.status === 'approved';
  } catch (err) {
    if ([20404, 60202, 60203].includes(err.code)) return false;
    throw err;
  }
}
