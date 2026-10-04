/**
 * What Dimts sells and what each call costs. The single source of truth for
 * prices: the app reads it through /api/billing, and scripts/polar-setup.js
 * creates the matching Polar products from it, so the price a user sees is
 * the price Polar charges.
 *
 * The model, in one paragraph: a plan buys monthly minutes. A call uses plan
 * minutes while both legs ring cheap countries (US, Canada, UK, EEA). Each leg
 * that rings an expensive country (the Gulf, Ethiopia) adds a per-minute
 * surcharge paid from prepaid credits, because carriers charge us up to 30
 * times more there. When plan minutes run out, calls continue on credits at
 * the overage rate. 1 credit = 1 US cent. Credits never expire.
 */
import { callingCode } from './destinations.js';

/** Minutes reset on the first of each month (UTC), on monthly and yearly plans alike. */
export const PLANS = {
  free: { minutes: 30, features: ['notes', 'agreements', 'ask'] },
  pro: { minutes: 500, features: ['notes', 'agreements', 'ask', 'recaps', 'promises', 'memory_check', 'business_number', 'google'] },
  business: { minutes: 1500, features: ['notes', 'agreements', 'ask', 'recaps', 'promises', 'memory_check', 'business_number', 'google', 'live_memory_check', 'priority_support'] },
};
export const PAID_PLANS = ['pro', 'business'];
export const INTERVALS = ['month', 'year'];

/** Credits per minute once plan minutes are used up (covers both cheap legs and the AI). */
export const OVERAGE_CENTS_PER_MIN = 3;

/**
 * Credits per minute for one leg ringing a number in this country. Set above
 * Twilio's published mobile rates so the margin survives carrier changes;
 * reconcile against the Telnyx rate sheet before lowering. Countries not
 * listed (US, Canada, UK, EEA) cost no surcharge.
 */
export const LEG_SURCHARGE_CENTS = {
  971: 30, // United Arab Emirates
  966: 20, // Saudi Arabia
  974: 35, // Qatar
  973: 20, // Bahrain
  965: 20, // Kuwait
  968: 45, // Oman
  251: 50, // Ethiopia
};

export function legSurcharge(number) {
  const code = callingCode(number);
  return code ? (LEG_SURCHARGE_CENTS[code] ?? 0) : 0;
}

/**
 * Surcharge per minute for a call. An outbound call rings the owner's handset
 * and then the other person. An inbound call arrives on our US number and is
 * forwarded to the owner, so only the owner's leg is priced.
 */
export function callSurcharge(ownerPhone, otherPhone, direction = 'outbound') {
  return legSurcharge(ownerPhone) + (direction === 'inbound' ? 0 : legSurcharge(otherPhone));
}

/** Credits a finished call costs. Credits are charged per started minute, like the carriers bill us. */
export function callCredits(seconds, planSeconds, surcharge, overage = OVERAGE_CENTS_PER_MIN) {
  if (seconds <= 0) return 0;
  return Math.ceil(seconds / 60) * surcharge + Math.ceil(Math.max(0, seconds - planSeconds) / 60) * overage;
}

/** The longest call, up to `cap` seconds, that plan minutes plus the credit balance can pay for. */
export function affordableSeconds({ planSecondsLeft, credits, surcharge, overage = OVERAGE_CENTS_PER_MIN, cap = 1800 }) {
  let best = surcharge === 0 ? Math.min(Math.max(0, planSecondsLeft), cap) : 0;
  for (let seconds = 60; seconds <= cap; seconds += 60) {
    if (callCredits(seconds, planSecondsLeft, surcharge, overage) > credits) break;
    best = Math.max(best, seconds);
  }
  return best;
}

/**
 * Regional pricing. The region comes from the user's verified phone number,
 * not their IP address, so a VPN cannot move someone into a cheaper region.
 * `lite` is for countries where the standard price is out of reach; it only
 * lowers plan prices. Credits cost the same everywhere because they pay real
 * carrier costs.
 */
const LITE_REGION = new Set(['251']);
export const priceRegion = phone => (LITE_REGION.has(callingCode(phone)) ? 'lite' : 'standard');

const CANADA_AREA_CODES = new Set([
  '204', '226', '236', '249', '250', '263', '289', '306', '343', '354', '365', '367', '368', '382', '403', '416',
  '418', '428', '431', '437', '438', '450', '468', '474', '506', '514', '519', '548', '579', '581', '584', '587',
  '604', '613', '639', '647', '672', '683', '705', '709', '742', '753', '778', '780', '782', '807', '819', '825',
  '867', '873', '879', '902', '905',
]);
const EEA_CODES = new Set([
  '43', '32', '359', '385', '357', '420', '45', '372', '358', '33', '49', '30', '36', '353', '39',
  '371', '370', '352', '356', '31', '48', '351', '40', '421', '386', '34', '46', '354', '423', '47',
]);

/** The currency prices are shown and charged in. Polar handles VAT and sales tax on top. */
export function displayCurrency(phone) {
  const code = callingCode(phone);
  if (priceRegion(phone) === 'lite') return 'usd';
  if (code === '1') return CANADA_AREA_CODES.has(phone.slice(2, 5)) ? 'cad' : 'usd';
  if (code === '44') return 'gbp';
  if (EEA_CODES.has(code)) return 'eur';
  if (code === '971') return 'aed';
  if (code === '966') return 'sar';
  return 'usd';
}

/**
 * Plan prices in minor units, per region, interval and currency. Yearly is ten
 * months' price: two months free. Local prices are rounded to numbers that
 * look deliberate in that currency rather than converted to the cent.
 */
export const PLAN_PRICES = {
  standard: {
    pro: {
      month: { usd: 1900, eur: 1900, gbp: 1600, cad: 2600, aed: 6900, sar: 6900 },
      year: { usd: 19000, eur: 19000, gbp: 16000, cad: 26000, aed: 69000, sar: 69000 },
    },
    business: {
      month: { usd: 4900, eur: 4900, gbp: 4200, cad: 6600, aed: 17900, sar: 17900 },
      year: { usd: 49000, eur: 49000, gbp: 42000, cad: 66000, aed: 179000, sar: 179000 },
    },
  },
  lite: {
    pro: { month: { usd: 700 }, year: { usd: 7000 } },
    business: { month: { usd: 1900 }, year: { usd: 19000 } },
  },
};

/** One-time credit packs. Bigger packs carry a bonus. */
export const CREDIT_PACKS = {
  credits_10: { credits: 1000, prices: { usd: 1000, eur: 1000, gbp: 900, cad: 1400, aed: 3700, sar: 3800 } },
  credits_25: { credits: 2600, prices: { usd: 2500, eur: 2500, gbp: 2200, cad: 3500, aed: 9200, sar: 9400 } },
  credits_50: { credits: 5500, prices: { usd: 5000, eur: 5000, gbp: 4300, cad: 6900, aed: 18400, sar: 18800 } },
};

/** Polar product key for a plan, e.g. `pro_month` or `business_year_lite`. */
export const planProductKey = (plan, interval, region) => `${plan}_${interval}${region === 'lite' ? '_lite' : ''}`;

/** Price in the wanted currency, falling back to US dollars where a local price is not set. */
export function pick(prices, currency) {
  return prices[currency] != null ? { amount: prices[currency], currency } : { amount: prices.usd, currency: 'usd' };
}

/** What the app shows on the plans screen for this user. */
export function catalogFor(phone) {
  const region = priceRegion(phone);
  const currency = displayCurrency(phone);
  return {
    region,
    currency,
    overage_cents_per_min: OVERAGE_CENTS_PER_MIN,
    // Calling code → credits a minute for each leg in that country.
    leg_surcharges: LEG_SURCHARGE_CENTS,
    plans: Object.entries(PLANS).map(([id, plan]) => ({
      id,
      minutes: plan.minutes,
      features: plan.features,
      prices: id === 'free' ? null : Object.fromEntries(INTERVALS.map(i => [i, pick(PLAN_PRICES[region][id][i], currency)])),
    })),
    credit_packs: Object.entries(CREDIT_PACKS).map(([id, pack]) => ({ id, credits: pack.credits, price: pick(pack.prices, currency) })),
  };
}

export const planOf = user => (PLANS[user?.tier] ? user.tier : 'free');
