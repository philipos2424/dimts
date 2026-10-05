import { config } from '../config.js';
import { query } from '../db/pool.js';
import { hit } from '../lib/rate-limit.js';
import { HttpError } from '../lib/users.js';
import { telnyxRequest } from '../lib/telnyx-rest.js';
import { twilioClient } from '../lib/twilio-client.js';

// Calling code for each country we can buy numbers in. US and Canada share +1,
// so a +1 owner gets the first of the two listed in NUMBER_COUNTRIES.
const CALLING_CODES = { US: '1', CA: '1', GB: '44', IE: '353', DE: '49', FR: '33', NL: '31', ES: '34', IT: '39', SE: '46' };

/**
 * Countries where numbers are bought automatically. Defaults to the US: UK and
 * EU local numbers need an address or ID on file at the carrier first, so an
 * operator adds them only once that paperwork is approved.
 */
export function numberCountries() {
  const listed = (process.env.NUMBER_COUNTRIES ?? 'US').split(',').map(c => c.trim().toUpperCase()).filter(c => CALLING_CODES[c]);
  return listed.length ? listed : ['US'];
}

/** A local number in the owner's own country when we sell there, otherwise the first listed country. */
export function countryFor(ownerPhone, countries = numberCountries()) {
  const digits = String(ownerPhone ?? '').replace(/^\+/, '');
  return countries.find(c => digits.startsWith(CALLING_CODES[c])) ?? countries[0];
}

async function buyTelnyx(country) {
  const params = new URLSearchParams({
    'filter[country_code]': country, 'filter[features][]': 'voice', 'filter[phone_number_type]': 'local', 'filter[limit]': '1',
  });
  const found = await telnyxRequest('GET', `/available_phone_numbers?${params}`, { timeout: 15_000 });
  const phone = (Array.isArray(found) ? found : [])[0]?.phoneNumber;
  if (!phone) return null;
  // The TeXML application routes the number to /twiml/incoming, as stock-number.js requires.
  const order = await telnyxRequest('POST', '/number_orders', {
    json: { phone_numbers: [{ phone_number: phone }], connection_id: config.telnyxTexmlAppId }, timeout: 20_000,
  });
  const ordered = order?.phoneNumbers?.find(n => n.phoneNumber === phone);
  if (!ordered || ordered.status === 'failure' || order.status === 'failure') throw new Error('Telnyx number order failed');
  return { phone, sid: ordered.id ?? order.id };
}

async function buyTwilio(country, voiceUrl) {
  const client = twilioClient({ timeout: 20_000 });
  const [available] = await client.availablePhoneNumbers(country).local.list({ voiceEnabled: true, limit: 1 });
  if (!available) return null;
  const number = await client.incomingPhoneNumbers.create({ phoneNumber: available.phoneNumber, voiceUrl, voiceMethod: 'POST' });
  return { phone: number.phoneNumber, sid: number.sid };
}

/**
 * Buy one number and add it to the pool, so the next claim finds it. Spending
 * is capped: a daily ceiling across all accounts and two purchases an hour per
 * account, so a bug or a double tap cannot buy numbers without limit. A number
 * bought but then claimed by someone else is not wasted; it stays in the pool.
 */
export async function buyPoolNumber({ userId, ownerPhone, voiceUrl }) {
  if (process.env.NUMBER_AUTOBUY === 'off') return null;
  await hit(`number-buy:${userId}`, 2, 3600);
  await hit('number-buy-all', Number(process.env.NUMBER_AUTOBUY_DAILY_MAX) || 20, 86_400);
  const country = countryFor(ownerPhone);
  const bought = config.carrier === 'telnyx' ? await buyTelnyx(country) : await buyTwilio(country, voiceUrl);
  if (!bought) throw new HttpError(409, 'number_pool_empty', 'No business number is available in your country right now. Try again later.');
  await query(`INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES($1,$2,$3)
    ON CONFLICT(phone) DO UPDATE SET enabled=true, voice_url=EXCLUDED.voice_url`, [bought.phone, bought.sid, voiceUrl]);
  console.log(`[numbers] bought ${bought.phone} (${country}) for the pool`);
  return bought.phone;
}

