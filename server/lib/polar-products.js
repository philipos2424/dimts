import { CREDIT_PACKS, INTERVALS, PAID_PLANS, planProductKey } from './pricing.js';

/** Every product key Dimts sells; scripts/polar-setup.js creates one Polar product per key. */
export const PRODUCT_KEYS = [
  ...PAID_PLANS.flatMap(plan => INTERVALS.flatMap(interval => ['standard', 'lite'].map(region => planProductKey(plan, interval, region)))),
  ...Object.keys(CREDIT_PACKS),
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POLAR_PRODUCTS maps each product key to its Polar product ID, as printed by
 * scripts/polar-setup.js. Returns null when billing is not configured.
 */
export function polarProducts(env = process.env) {
  if (!env.POLAR_PRODUCTS) return null;
  const map = JSON.parse(env.POLAR_PRODUCTS);
  for (const key of PRODUCT_KEYS) if (!UUID.test(map?.[key] ?? '')) throw new Error(`POLAR_PRODUCTS is missing ${key}`);
  return map;
}

/** Product key for a Polar product ID, or null for a product Dimts does not sell. */
export function productKeyFor(productId, env = process.env) {
  const map = polarProducts(env);
  if (!map) return null;
  return PRODUCT_KEYS.find(key => map[key] === productId) ?? null;
}

/** `pro_year_lite` → { plan: 'pro', interval: 'year' }; null for credit packs. */
export function parsePlanKey(key) {
  const match = /^(pro|business)_(month|year)(?:_lite)?$/.exec(key ?? '');
  return match ? { plan: match[1], interval: match[2] } : null;
}
