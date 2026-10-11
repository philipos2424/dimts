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
  // After the trial, Free keeps every past call readable and askable; new calls need a plan.
  free: { minutes: 0, features: ['notes', 'agreements', 'ask'] },
  pro: { minutes: 500, features: ['notes', 'agreements', 'ask', 'recaps', 'promises', 'memory_check', 'business_number', 'google'] },
  business: { minutes: 1500, features: ['notes', 'agreements', 'ask', 'recaps', 'promises', 'memory_check', 'business_number', 'google', 'priority_support'] },
};
export const PAID_PLANS = ['pro', 'business'];
export const INTERVALS = ['month', 'year'];

/** Credits per minute once plan minutes are used up (covers both cheap legs and the AI). */
export const OVERAGE_CENTS_PER_MIN = 3;

/**
 * UK and EU legs cost us 2.5 and 5 times a US leg (pricing.js LEG_COST_MICROS),
 * so over-plan minutes add this much per leg ringing there. A UK-to-UK minute
 * is 7 credits against about 4.7 cents of cost; EU-to-EU is 11 against 8.7.
 */
export const OVERAGE_LEG_EXTRA_CENTS = { 44: 2, eea: 4 };

/**
 * Plan minutes depend on where the owner's number is, for the same reason:
 * most of an owner's calls ring phones in their own country.
 */
export const REGIONAL_MINUTES = {
  uk: { pro: 300, business: 900 },
  eea: { pro: 200, business: 500 },
};

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

function legRegion(number) {
  const code = callingCode(number);
  if (code === '44') return '44';
  return code && EEA_CODES.has(code) ? 'eea' : null;
}

/** Over-plan credits a minute for this call: the base rate plus each UK or EU leg. */
export function overageRate(ownerPhone, otherPhone, direction = 'outbound') {
  const extra = number => OVERAGE_LEG_EXTRA_CENTS[legRegion(number)] ?? 0;
  return OVERAGE_CENTS_PER_MIN + extra(ownerPhone) + (direction === 'inbound' ? 0 : extra(otherPhone));
}

/** Monthly plan minutes for this owner: fewer where calls cost us more. */
export function planMinutes(tier, ownerPhone, { trial = false, override = null } = {}) {
  // Granted by hand (scripts/grant-minutes.js): wins over the plan and the trial.
  if (Number.isInteger(override) && override >= 0) return override;
  if (trial) return TRIAL_MINUTES;
  const region = { 44: 'uk', eea: 'eea' }[legRegion(ownerPhone)];
  return REGIONAL_MINUTES[region]?.[tier] ?? PLANS[tier]?.minutes ?? PLANS.free.minutes;
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
 * One price list everywhere, from $20 a month (founder, 2026-10-12). A regional
 * discount for Ethiopia existed until then; it put Pro at $7, below the cost of
 * card fees plus the minutes. Ethiopian numbers can still sign up and buy.
 */
export const priceRegion = () => 'standard';

const CANADA_AREA_CODES = new Set([
  '204', '226', '236', '249', '250', '263', '289', '306', '343', '354', '365', '367', '368', '382', '403', '416',
  '418', '428', '431', '437', '438', '450', '468', '474', '506', '514', '519', '548', '579', '581', '584', '587',
  '604', '613', '639', '647', '672', '683', '705', '709', '742', '753', '778', '780', '782', '807', '819', '825',
  '867', '873', '879', '902', '905',
]);
export const EEA_CODES = new Set([
  '43', '32', '359', '385', '357', '420', '45', '372', '358', '33', '49', '30', '36', '353', '39',
  '371', '370', '352', '356', '31', '48', '351', '40', '421', '386', '34', '46', '354', '423', '47',
]);

/** The currency prices are shown and charged in. Polar handles VAT and sales tax on top. */
export function displayCurrency(phone) {
  const code = callingCode(phone);
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
      month: { usd: 2000, eur: 2000, gbp: 1600, cad: 2800, aed: 7500, sar: 7500 },
      year: { usd: 20000, eur: 20000, gbp: 16000, cad: 28000, aed: 75000, sar: 75000 },
    },
    business: {
      month: { usd: 5000, eur: 5000, gbp: 4000, cad: 7000, aed: 18500, sar: 19000 },
      year: { usd: 50000, eur: 50000, gbp: 40000, cad: 70000, aed: 185000, sar: 190000 },
    },
  },
};

/** One-time credit packs. Bigger packs carry a bonus. */
export const CREDIT_PACKS = {
  credits_10: { credits: 1000, prices: { usd: 1000, eur: 1000, gbp: 900, cad: 1400, aed: 3700, sar: 3800 } },
  credits_25: { credits: 2600, prices: { usd: 2500, eur: 2500, gbp: 2200, cad: 3500, aed: 9200, sar: 9400 } },
  credits_50: { credits: 5500, prices: { usd: 5000, eur: 5000, gbp: 4300, cad: 6900, aed: 18400, sar: 18800 } },
};

/** Polar product key for a plan, e.g. `pro_month` or `business_year`. */
export const planProductKey = (plan, interval) => `${plan}_${interval}`;

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
    overage_leg_extra_cents: OVERAGE_LEG_EXTRA_CENTS,
    // Calling code → credits a minute for each leg in that country.
    leg_surcharges: LEG_SURCHARGE_CENTS,
    plans: Object.entries(PLANS).map(([id, plan]) => ({
      id,
      minutes: planMinutes(id, phone),
      features: plan.features,
      prices: id === 'free' ? null : Object.fromEntries(INTERVALS.map(i => [i, pick(PLAN_PRICES[region][id][i], currency)])),
    })),
    credit_packs: Object.entries(CREDIT_PACKS).map(([id, pack]) => ({ id, credits: pack.credits, price: pick(pack.prices, currency) })),
  };
}

/**
 * A new account tries Pro for 21 days, capped at 20 minutes, from its first
 * call: a trial converts several times better than a permanent free tier, and
 * the cap bounds what one account can cost (about $0.45 in the US). The
 * shared monthly pool (GLOBAL_CALL_MINUTES_PER_MONTH) bounds all trials together.
 */
export const TRIAL_DAYS = 21;
// Twenty minutes: two or three real calls, so the memory across calls can show itself.
export const TRIAL_MINUTES = 20;
// A trial call that starts with minutes left may finish, up to this long. Cutting a
// first call off mid-sentence, with the owner's customer on the line, loses the user.
export const TRIAL_CALL_GRACE_SECONDS = 15 * 60;
export const onTrial = (user, now = Date.now()) => (user?.tier ?? 'free') === 'free'
  && !!user?.trial_ends_at && new Date(user.trial_ends_at).getTime() > now;
export const planOf = user => (onTrial(user) ? 'pro' : PLANS[user?.tier] ? user.tier : 'free');

/**
 * What one minute of one leg costs us, in micro-dollars, before the actual
 * bill arrives (provider_costs holds the real figures, synced daily).
 * Includes Telnyx's $0.002 call-control fee. Ethiopia is measured: $0.3361
 * a minute on Telnyx in October 2026. The rest are estimates to be replaced
 * as provider_costs fills in.
 */
export const LEG_COST_MICROS = { default: 8000, 44: 20000, eea: 40000, 971: 200000, 966: 120000, 974: 220000, 973: 150000, 965: 150000, 968: 300000, 251: 338100 };
const RECORDING_MICROS_PER_MIN = 2000;
const TRANSCRIBE_MICROS_PER_MIN = 4500; // Scribe v2 $0.22/h + keyterms $0.05/h

export function legCost(number) {
  const code = callingCode(number);
  if (!code) return LEG_COST_MICROS.default;
  if (LEG_COST_MICROS[code] != null) return LEG_COST_MICROS[code];
  return EEA_CODES.has(code) ? LEG_COST_MICROS.eea : LEG_COST_MICROS.default;
}

/**
 * Estimated cost of a finished call. Carriers bill each leg per started
 * minute, and the owner's leg runs from answer, so a short ring is counted.
 */
export function estimateCallCost({ ownerPhone, otherPhone, direction, seconds, recorded }) {
  if (!(seconds > 0)) return 0;
  const minutes = Math.ceil(seconds / 60);
  const legs = legCost(ownerPhone) + (direction === 'inbound' ? LEG_COST_MICROS.default : legCost(otherPhone));
  return minutes * legs + (recorded ? minutes * RECORDING_MICROS_PER_MIN + Math.ceil(seconds / 60 * TRANSCRIBE_MICROS_PER_MIN) : 0);
}
