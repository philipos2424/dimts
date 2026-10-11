// Create the Polar products Dimts sells, from the prices in lib/pricing.js,
// and print the POLAR_PRODUCTS value to set in the environment. Safe to rerun:
// a product tagged with its dimts_key is reused while its prices still match.
// When prices change, the old product is archived (no new purchases; current
// subscribers keep the price they agreed to) and a new one is created. Tagged
// products Dimts no longer sells (e.g. the old regional `_lite` plans) are archived.
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
for (const plan of PAID_PLANS) for (const interval of INTERVALS) {
  wanted.push({
    key: planProductKey(plan, interval),
    name: `Dimts ${title(plan)} (${interval === 'month' ? 'monthly' : 'yearly'})`,
    description: `${PLANS[plan].minutes} call minutes a month to the US, Canada, UK and Europe, with AI notes, agreements and follow-ups. Renews every ${interval}; cancel any time from the app.`,
    recurring_interval: interval,
    prices: fixed(PLAN_PRICES.standard[plan][interval]),
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
  for (const product of items) if (product.metadata?.dimts_key) existing.set(product.metadata.dimts_key, product);
  if (page >= (pagination?.max_page ?? 1)) break;
}

const priceKey = prices => JSON.stringify(prices.filter(p => !p.is_archived && p.amount_type === 'fixed')
  .map(p => [p.price_currency, p.price_amount]).sort());
const archive = async (product, why) => {
  await polar('PATCH', `/v1/products/${product.id}`, { is_archived: true });
  console.error(`archived ${product.metadata.dimts_key} (${why})`);
};

const ids = {};
for (const [key, product] of existing) if (!wanted.some(w => w.key === key)) await archive(product, 'no longer sold');
for (const { key, ...product } of wanted) {
  const old = existing.get(key);
  if (old && priceKey(old.prices) === priceKey(product.prices)) { ids[key] = old.id; console.error(`kept    ${key}`); continue; }
  if (old) await archive(old, 'prices changed');
  const created = await polar('POST', '/v1/products/', { ...product, metadata: { dimts_key: key } });
  ids[key] = created.id;
  console.error(`created ${key}`);
}
console.error(`\nSet this in ${production ? 'production' : 'the sandbox environment'}${production ? '' : ' with POLAR_SERVER=sandbox'}:`);
console.log(`POLAR_PRODUCTS=${JSON.stringify(ids)}`);
