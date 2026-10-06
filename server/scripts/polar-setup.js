// Create the Polar products Dimts sells, from the prices in lib/pricing.js,
// and print the POLAR_PRODUCTS value to set in the environment. Safe to rerun:
// products already tagged with their dimts_key are reused, not duplicated.
// Price changes are not applied to existing products; archive the old product
// in Polar and rerun, so current subscribers keep the price they agreed to.
// Usage: node --env-file=../.env scripts/polar-setup.js            (sandbox)
//        node --env-file=../.env scripts/polar-setup.js --production
import { CREDIT_PACKS, INTERVALS, PAID_PLANS, PLANS, PLAN_PRICES, planProductKey } from '../lib/pricing.js';

const production = process.argv.includes('--production');
const api = production ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh';
const token = process.env.POLAR_ACCESS_TOKEN;
if (!token) throw new Error('Set POLAR_ACCESS_TOKEN (an organization access token with products:read and products:write)');

async function polar(method, path, body) {
  const res = await fetch(api + path, { method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 800)}`);
  return res.json();
}

const fixed = prices => Object.entries(prices).map(([currency, amount]) => ({ amount_type: 'fixed', price_amount: amount, price_currency: currency }));
const title = word => word[0].toUpperCase() + word.slice(1);

const wanted = [];
for (const plan of PAID_PLANS) for (const interval of INTERVALS) for (const region of ['standard', 'lite']) {
  wanted.push({
    key: planProductKey(plan, interval, region),
    name: `Dimts ${title(plan)} (${interval === 'month' ? 'monthly' : 'yearly'}${region === 'lite' ? ', regional' : ''})`,
    description: `${PLANS[plan].minutes} call minutes a month to the US, Canada, UK and Europe, with AI notes, agreements and follow-ups. Renews every ${interval}; cancel any time from the app.`,
    recurring_interval: interval,
    prices: fixed(PLAN_PRICES[region][plan][interval]),
  });
}
for (const [key, pack] of Object.entries(CREDIT_PACKS)) {
  wanted.push({ key, name: `Dimts credits: ${pack.credits.toLocaleString('en-US')}`,
    description: `${pack.credits.toLocaleString('en-US')} call credits (1 credit = US$0.01) for calls to and from the Gulf, Ethiopia and beyond your plan minutes. Credits never expire.`,
    prices: fixed(pack.prices) });
}

const existing = new Map();
for (let page = 1; ; page++) {
  const { items, pagination } = await polar('GET', `/v1/products/?limit=100&page=${page}&is_archived=false`);
  for (const product of items) if (product.metadata?.dimts_key) existing.set(product.metadata.dimts_key, product.id);
  if (page >= (pagination?.max_page ?? 1)) break;
}

const ids = {};
for (const { key, ...product } of wanted) {
  if (existing.has(key)) { ids[key] = existing.get(key); console.error(`kept    ${key}`); continue; }
  const created = await polar('POST', '/v1/products/', { ...product, metadata: { dimts_key: key } });
  ids[key] = created.id;
  console.error(`created ${key}`);
}
console.error(`\nSet this in ${production ? 'production' : 'the sandbox environment'}${production ? '' : ' with POLAR_SERVER=sandbox'}:`);
console.log(`POLAR_PRODUCTS=${JSON.stringify(ids)}`);
