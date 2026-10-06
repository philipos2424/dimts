import test from 'node:test';
import assert from 'node:assert/strict';
import { CREDIT_PACKS, PLAN_PRICES, affordableSeconds, callCredits, callSurcharge, catalogFor, displayCurrency, priceRegion } from './pricing.js';
import { PRODUCT_KEYS, parsePlanKey, polarProducts, productKeyFor } from './polar-products.js';

const US = '+12025550101', TORONTO = '+14165550101', UK = '+447700900123', DE = '+4915112345678';
const UAE = '+971501234567', ET = '+251911234567';

test('cheap countries ride on plan minutes; each expensive leg adds its surcharge', () => {
  assert.equal(callSurcharge(US, UK), 0);
  assert.equal(callSurcharge(DE, US), 0);
  assert.equal(callSurcharge(US, ET), 50, 'diaspora owner calling home pays one Ethiopian leg');
  assert.equal(callSurcharge(ET, ET), 100, 'both legs ring Ethiopia');
  assert.equal(callSurcharge(UAE, US), 30);
  assert.equal(callSurcharge(ET, '+12025550199', 'inbound'), 50, 'inbound arrives on our US number; only the owner leg is priced');
  assert.equal(callSurcharge(US, '+19005550100'), 0, 'premium numbers are never priced, they are refused elsewhere');
});

test('credits are charged per started minute: surcharge on every minute, overage past plan minutes', () => {
  assert.equal(callCredits(0, 0, 50), 0);
  assert.equal(callCredits(61, 600, 0), 0);
  assert.equal(callCredits(61, 600, 50), 100);
  assert.equal(callCredits(125, 60, 0), 6, '65 seconds over the plan = 2 started minutes at 3');
  assert.equal(callCredits(125, 0, 50), 159);
});

test('the affordable call length respects plan minutes, credits and the 30-minute cap', () => {
  assert.equal(affordableSeconds({ planSecondsLeft: 90, credits: 0, surcharge: 0 }), 90);
  assert.equal(affordableSeconds({ planSecondsLeft: 0, credits: 0, surcharge: 0 }), 0);
  assert.equal(affordableSeconds({ planSecondsLeft: 0, credits: 30, surcharge: 0 }), 600);
  assert.equal(affordableSeconds({ planSecondsLeft: 99999, credits: 0, surcharge: 0 }), 1800);
  assert.equal(affordableSeconds({ planSecondsLeft: 99999, credits: 1000, surcharge: 50 }), 1200);
  assert.equal(affordableSeconds({ planSecondsLeft: 99999, credits: 49, surcharge: 50 }), 0);
  assert.equal(affordableSeconds({ planSecondsLeft: 120, credits: 106, surcharge: 50 }), 120, 'third minute would also need overage');
});

test('the verified phone number sets region and currency, not the IP address', () => {
  assert.equal(priceRegion(ET), 'lite');
  assert.equal(priceRegion(UAE), 'standard');
  assert.deepEqual([US, TORONTO, UK, DE, UAE, '+966501234567', '+97455123456', ET].map(displayCurrency),
    ['usd', 'cad', 'gbp', 'eur', 'aed', 'sar', 'usd', 'usd']);
});

test('every price has a US-dollar fallback and yearly is two months free', () => {
  for (const region of Object.values(PLAN_PRICES)) for (const plan of Object.values(region)) {
    for (const [currency, monthly] of Object.entries(plan.month)) assert.equal(plan.year[currency], monthly * 10, currency);
    assert.ok(plan.month.usd > 0);
  }
  for (const pack of Object.values(CREDIT_PACKS)) assert.ok(pack.prices.usd > 0 && pack.credits >= pack.prices.usd);
  const lite = catalogFor(ET);
  assert.equal(lite.plans.find(p => p.id === 'pro').prices.month.amount, 700);
  const gulf = catalogFor('+97455123456');
  assert.deepEqual(gulf.plans.find(p => p.id === 'business').prices.year, { amount: 49000, currency: 'usd' });
  assert.deepEqual(catalogFor(UK).credit_packs[0].price, { amount: 900, currency: 'gbp' });
  assert.equal(catalogFor(US).plans.find(p => p.id === 'free').prices, null);
});

test('POLAR_PRODUCTS must name a product for every key', () => {
  const ids = Object.fromEntries(PRODUCT_KEYS.map((key, i) => [key, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`]));
  const env = { POLAR_PRODUCTS: JSON.stringify(ids) };
  assert.equal(PRODUCT_KEYS.length, 11);
  assert.equal(productKeyFor(ids.business_year_lite, env), 'business_year_lite');
  assert.equal(productKeyFor('00000000-0000-4000-8000-999999999999', env), null);
  assert.deepEqual(parsePlanKey('business_year_lite'), { plan: 'business', interval: 'year' });
  assert.equal(parsePlanKey('credits_10'), null);
  assert.equal(polarProducts({}), null);
  const { credits_50, ...missing } = ids;
  assert.throws(() => polarProducts({ POLAR_PRODUCTS: JSON.stringify(missing) }), /credits_50/);
});
