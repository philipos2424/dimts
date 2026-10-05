import { config } from '../config.js';
import { query } from '../db/pool.js';
import { hit } from '../lib/rate-limit.js';
import { HttpError } from '../lib/users.js';
import { telnyxRequest } from '../lib/telnyx-rest.js';
import { twilioClient } from '../lib/twilio-client.js';

// Calling code for each country we can buy numbers in. US and Canada share +1
// and are told apart by area code.
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

const CANADIAN_AREA_CODES = new Set(('204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 387 403 416 418 428 431 '
  + '437 438 450 460 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 '
  + '825 867 873 879 902 905 942').split(' '));

/** The owner's +1 area code, so their business number looks local to the people they call. */
export function areaCodeOf(ownerPhone) {
  return /^\+1([2-9]\d{2})/.exec(String(ownerPhone ?? ''))?.[1] ?? null;
}

/** A local number in the owner's own country when we sell there, otherwise the first listed country. */
export function countryFor(ownerPhone, countries = numberCountries()) {
  const areaCode = areaCodeOf(ownerPhone);
  if (areaCode) {
    const nanp = CANADIAN_AREA_CODES.has(areaCode) ? 'CA' : 'US';
    if (countries.includes(nanp)) return nanp;
  }
  const digits = String(ownerPhone ?? '').replace(/^\+/, '');
  return countries.find(c => digits.startsWith(CALLING_CODES[c])) ?? countries[0];
}

async function findTelnyx(country, areaCode) {
  const params = new URLSearchParams({
    'filter[country_code]': country, 'filter[features][]': 'voice', 'filter[phone_number_type]': 'local', 'filter[limit]': '1',
  });
  if (areaCode) params.set('filter[national_destination_code]', areaCode);
  const found = await telnyxRequest('GET', `/available_phone_numbers?${params}`, { timeout: 15_000 });
  return (Array.isArray(found) ? found : [])[0]?.phoneNumber;
}

async function buyTelnyx(country, areaCode) {
  // The owner's own area code first; any local number in the country if it has none left.
  const phone = (areaCode && await findTelnyx(country, areaCode)) || await findTelnyx(country);
  if (!phone) return null;
  // The TeXML application routes the number to /twiml/incoming, as stock-number.js requires.
  const order = await telnyxRequest('POST', '/number_orders', {
    json: { phone_numbers: [{ phone_number: phone }], connection_id: config.telnyxTexmlAppId }, timeout: 20_000,
  });
  const ordered = order?.phoneNumbers?.find(n => n.phoneNumber === phone);
  if (!ordered || ordered.status === 'failure' || order.status === 'failure') throw new Error('Telnyx number order failed');
  return { phone, sid: ordered.id ?? order.id };
}

async function buyTwilio(country, areaCode, voiceUrl) {
  const client = twilioClient({ timeout: 20_000 });
  const search = filters => client.availablePhoneNumbers(country).local.list({ voiceEnabled: true, limit: 1, ...filters });
  const [local] = areaCode ? await search({ areaCode: Number(areaCode) }) : [];
  const available = local ?? (await search({}))[0];
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
  // An area code only means something inside the owner's own country.
  const areaCode = CALLING_CODES[country] === '1' ? areaCodeOf(ownerPhone) : null;
  const bought = config.carrier === 'telnyx' ? await buyTelnyx(country, areaCode) : await buyTwilio(country, areaCode, voiceUrl);
  if (!bought) throw new HttpError(409, 'number_pool_empty', 'No business number is available in your country right now. Try again later.');
  await query(`INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES($1,$2,$3)
    ON CONFLICT(phone) DO UPDATE SET enabled=true, voice_url=EXCLUDED.voice_url`, [bought.phone, bought.sid, voiceUrl]);
  console.log(`[numbers] bought ${bought.phone} (${country}) for the pool`);
  return bought.phone;
}

