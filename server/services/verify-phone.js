import twilio from 'twilio';
import { config } from '../config.js';

function service() {
  return twilio(config.twilioAccountSid, config.twilioAuthToken, { timeout: 15_000 })
    .verify.v2.services(config.twilioVerifyServiceSid);
}

export async function sendPhoneCode(phone) {
  await service().verifications.create({ to: phone, channel: 'sms' });
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
