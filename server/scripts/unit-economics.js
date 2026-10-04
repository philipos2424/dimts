// What a month earned against what it cost. Revenue comes from Polar orders
// (payments), carrier cost from Telnyx's own bills (provider_costs, synced
// daily), and AI cost from call minutes at published prices. Read-only.
// Usage: node --env-file=../.env scripts/unit-economics.js [YYYY-MM] [--sync]
//   --sync first copies the last 30 days of Telnyx detail records.
import { query, closeDatabase } from '../db/pool.js';
import { syncProviderCosts } from '../services/provider-costs.js';

const month = process.argv.find(arg => /^\d{4}-\d{2}$/.test(arg)) ?? new Date().toISOString().slice(0, 7);
if (process.argv.includes('--sync')) console.error('synced', await syncProviderCosts({ days: 30 }));
const range = [`${month}-01`, `${month}-01`];
const dollars = micros => `$${(Number(micros) / 1e6).toFixed(2)}`;
const cents = (amount, currency) => `${(Number(amount) / 100).toFixed(2)} ${currency.toUpperCase()}`;

const revenue = (await query(`SELECT currency, product_key LIKE 'credits%' AS credits, count(*)::int AS orders,
    sum(total_amount - tax_amount)::bigint AS net, sum(refunded_amount)::bigint AS refunded,
    sum(total_amount)::bigint AS gross
  FROM payments WHERE paid_at >= $1::date AND paid_at < ($2::date + interval '1 month')
  GROUP BY 1, 2 ORDER BY 1, 2`, range)).rows;
const carrier = (await query(`SELECT record_type, country_code, sum(records)::int AS records, sum(billed_sec)::bigint AS billed_sec,
    sum(cost_micros)::bigint AS cost
  FROM provider_costs WHERE day >= $1::date AND day < ($2::date + interval '1 month')
  GROUP BY 1, 2 ORDER BY cost DESC`, range)).rows;
const calls = (await query(`SELECT count(*)::int AS calls, COALESCE(sum(duration_sec),0)::bigint AS seconds,
    COALESCE(sum(est_cost_micros),0)::bigint AS estimate,
    COALESCE(sum(CASE WHEN record_enabled THEN duration_sec ELSE 0 END),0)::bigint AS recorded_seconds
  FROM calls WHERE created_at >= $1::date AND created_at < ($2::date + interval '1 month') AND duration_sec > 0`, range)).rows[0];
const users = (await query(`SELECT tier, count(*)::int AS users, count(agent_number)::int AS numbers
  FROM users WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1`)).rows;

console.log(`\nUnit economics for ${month}\n`);
console.log('Revenue (after tax, before Polar fees)');
let feesUsd = 0, netUsd = 0;
for (const row of revenue) {
  // Polar Starter: 5% + 50¢, plus 1.5% for non-US cards (assumed for non-USD).
  const fee = row.orders * 50 + Number(row.net) * (row.currency === 'usd' ? 0.05 : 0.065);
  if (row.currency === 'usd') { feesUsd += fee; netUsd += Number(row.net) - Number(row.refunded); }
  console.log(`  ${row.credits ? 'credits' : 'plans  '}  ${row.orders} orders  ${cents(row.net, row.currency)}  refunded ${cents(row.refunded, row.currency)}  est. Polar fee ${cents(fee, row.currency)}`);
}
if (!revenue.length) console.log('  none yet');

console.log('\nCarrier cost, as billed by Telnyx');
let carrierMicros = 0;
for (const row of carrier) {
  carrierMicros += Number(row.cost);
  console.log(`  ${row.record_type.padEnd(13)} +${row.country_code || '-'}`.padEnd(24) + `${String(row.records).padStart(5)} records  ${String(Math.round(row.billed_sec / 60)).padStart(6)} min  ${dollars(row.cost)}`);
}
if (!carrier.length) console.log('  none synced yet (run with --sync, or wait for the daily cron)');

// Scribe v2 $0.22/h + keyterms $0.05/h; AI summaries are roughly $0.001 a minute.
const aiMicros = Math.round(Number(calls.recorded_seconds) / 3600 * 270_000 + Number(calls.recorded_seconds) / 60 * 1_000);
const numbersMicros = users.reduce((sum, row) => sum + row.numbers, 0) * 1_000_000;
console.log('\nCalls');
console.log(`  ${calls.calls} connected calls, ${Math.round(calls.seconds / 60)} min; our per-call estimate ${dollars(calls.estimate)} vs Telnyx bill ${dollars(carrierMicros)}`);
console.log(`  transcription + AI (estimated) ${dollars(aiMicros)}; business numbers held ${dollars(numbersMicros)}/month`);
console.log('\nAccounts');
for (const row of users) console.log(`  ${row.tier.padEnd(9)} ${row.users} users, ${row.numbers} with a business number`);

const costUsd = (carrierMicros + aiMicros + numbersMicros) / 1e4 + feesUsd;
console.log(`\nUSD only: net revenue $${(netUsd / 100).toFixed(2)}, cost $${(costUsd / 100).toFixed(2)}, gross profit $${((netUsd - costUsd) / 100).toFixed(2)}` +
  (netUsd > 0 ? ` (${Math.round((netUsd - costUsd) / netUsd * 100)}%)` : ''));
console.log('Fixed costs (Vercel, Supabase, AI subscriptions, domain) are not included.\n');
await closeDatabase();
