/**
 * The operator questions behind the console's Today, Growth and Operations
 * views: is Dimts healthy, what changed, where do people drop off, and what
 * should someone do now. Same rule as admin-metrics.js: metadata only. Call
 * failures are reported as categories, never as the stored error text, which
 * can echo a provider's response.
 */
import * as database from '../db/pool.js';
import { config } from '../config.js';
import { telnyxRequest } from '../lib/telnyx-rest.js';
import { callingCode } from '../lib/destinations.js';
import { CONNECTED, PAYING, compliance, excludedPhones } from './admin-metrics.js';

const query = (sql, params) => database.query(sql, params);
const queryOne = (sql, params) => database.queryOne(sql, params);
const num = value => Number(value ?? 0);

export const RANGES = [7, 30, 90];
export const rangeOf = value => (RANGES.includes(Number(value)) ? Number(value) : 30);

// A failed call the carrier reported (busy, no answer) is the other person's
// choice; a failure after connecting is ours to fix.
const CARRIER_OUTCOME = "(c.error ILIKE 'Call busy%' OR c.error ILIKE 'Call no-answer%' OR c.error ILIKE 'Call canceled%')";
const SYSTEM_FAILURE = `(c.status = 'failed' AND NOT COALESCE(${CARRIER_OUTCOME}, false))`;

/** Why calls failed, as a fixed set of categories. The raw error text never leaves the database. */
const FAILURE_CATEGORY = `CASE
  WHEN c.error IS NULL THEN 'No reason recorded'
  WHEN c.error ILIKE 'Call busy%' THEN 'Other person busy'
  WHEN c.error ILIKE 'Call no-answer%' THEN 'No answer'
  WHEN c.error ILIKE 'Call canceled%' THEN 'Cancelled before answer'
  WHEN c.error ILIKE 'Call failed%' THEN 'Carrier could not connect'
  WHEN c.error ILIKE '%interrupted or timed out%' THEN 'AI processing timed out'
  WHEN c.error ~* '(transcri|elevenlabs|scribe|whisper)' THEN 'Transcription'
  WHEN c.error ~* '(recording|audio|download)' THEN 'Recording or audio'
  WHEN c.error ~* '(openai|ollama|summar|json|model|llm)' THEN 'AI notes'
  ELSE 'Other' END`;

async function check(id, title, run) {
  try { return { id, title, ...(await run()) }; }
  catch (err) { return { id, title, status: 'warn', value: '—', detail: 'Could not check right now.', action: 'Look at the Vercel logs.', error: err?.code ?? 'check_failed' }; }
}

const LOW_BALANCE_USD = () => Number(process.env.TELNYX_LOW_BALANCE_USD ?? 20);

/** Live service health. Each check says what it found and, when it is not OK, what to do. */
export async function health() {
  const x = excludedPhones();
  return Promise.all([
    check('database', 'Database', async () => {
      await queryOne('SELECT 1 AS ok');
      return { status: 'ok', value: 'Reachable' };
    }),
    check('carrier_balance', 'Telnyx balance', async () => {
      if (config.carrier !== 'telnyx') return { status: 'info', value: 'Not on Telnyx', detail: `Carrier is ${config.carrier}; balance is only read for Telnyx.` };
      const { balance, currency } = await telnyxRequest('GET', '/balance', { timeout: 5000 });
      const amount = Number(balance);
      const status = amount < 5 ? 'fail' : amount < LOW_BALANCE_USD() ? 'warn' : 'ok';
      return { status, value: `${amount.toFixed(2)} ${currency ?? 'USD'}`,
        detail: status === 'ok' ? null : `Below ${LOW_BALANCE_USD()} ${currency ?? 'USD'}. Calls stop when it reaches zero.`,
        action: status === 'ok' ? null : 'Top up Telnyx (portal.telnyx.com → Billing).' };
    }),
    check('ai', 'AI providers configured', async () => {
      const missing = [];
      if (config.llmProvider === 'openai' && !process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
      if (config.transcribeProvider === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
      if (config.transcribeProvider === 'whisper' && !process.env.WHISPER_API_TOKEN) missing.push('WHISPER_API_TOKEN');
      return missing.length
        ? { status: 'fail', value: 'Missing keys', detail: missing.join(', '), action: 'Set the keys in Vercel (Production) and redeploy.' }
        : { status: 'ok', value: `${config.transcribeProvider} + ${config.llmProvider}` };
    }),
    check('stuck', 'Calls stuck making notes', async () => {
      const n = num((await queryOne(`SELECT count(*)::int AS n FROM calls c WHERE c.status = 'processing' AND c.deleted_at IS NULL
        AND COALESCE(c.processing_until, c.processing_requested_at + interval '10 minutes') < now() - interval '15 minutes'`)).n);
      return n ? { status: 'fail', value: String(n), detail: 'Notes have not arrived for 15+ minutes.', action: 'Check transcription/AI provider status and the Vercel logs; owners can retry from the call.' }
        : { status: 'ok', value: '0' };
    }),
    check('failures', 'Our call failures (24 hours)', async () => {
      const row = await queryOne(`SELECT count(*) FILTER (WHERE ${SYSTEM_FAILURE})::int AS failed, count(*)::int AS total
        FROM calls c JOIN users u ON u.id = c.user_id WHERE c.created_at > now() - interval '24 hours' AND u.phone <> ALL($1)`, [x]);
      const rate = row.total ? row.failed / row.total : 0;
      const status = row.failed >= 3 && rate > 0.2 ? 'fail' : row.failed >= 3 ? 'warn' : 'ok';
      return { status, value: `${row.failed} of ${row.total}`, detail: status === 'ok' ? null : 'Excludes busy and no-answer. See Operations → Why calls failed.',
        action: status === 'ok' ? null : 'Open Operations to see the failure category.' };
    }),
    check('numbers', 'Business numbers free to assign', async () => {
      const row = await queryOne(`SELECT count(*) FILTER (WHERE p.enabled AND u.id IS NULL)::int AS free, count(*)::int AS total
        FROM agent_number_pool p LEFT JOIN users u ON u.agent_number = p.phone`);
      return row.free ? { status: 'ok', value: `${row.free} of ${row.total}` }
        : { status: 'warn', value: `0 of ${row.total}`, detail: 'The next paying customer cannot get a business number.', action: 'Buy one: node server/scripts/buy-number.js.' };
    }),
    check('legal', 'Legal and privacy checks', async () => {
      const { checks } = await compliance();
      const failing = checks.filter(c => c.status === 'fail'), warning = checks.filter(c => c.status === 'warn');
      return failing.length ? { status: 'fail', value: `${failing.length} failing`, detail: failing.map(c => c.title).join('; '), action: 'Open Compliance.' }
        : warning.length ? { status: 'warn', value: `${warning.length} warning`, detail: warning.map(c => c.title).join('; '), action: 'Open Compliance.' }
          : { status: 'ok', value: 'All passing' };
    }),
  ]);
}

/**
 * Key numbers for the last `days` against the `days` before, so a change is
 * visible at a glance. `better` says which direction is good.
 */
export async function changes(days) {
  const x = excludedPhones();
  const window = (offset) => [`${days * (offset + 1)} days`, `${days * offset} days`];
  const metrics = async ([from, to]) => {
    const range = [x, from, to];
    const [signups, calls, revenue, paying] = await Promise.all([
      queryOne(`SELECT count(*)::int AS n FROM users WHERE phone <> ALL($1)
        AND created_at >= now() - $2::interval AND created_at < now() - $3::interval`, range),
      queryOne(`SELECT count(DISTINCT c.user_id) FILTER (WHERE ${CONNECTED})::int AS active,
          count(*) FILTER (WHERE ${CONNECTED})::int AS connected, count(*)::int AS total,
          COALESCE(round(sum(c.duration_sec) / 60.0), 0)::int AS minutes,
          count(*) FILTER (WHERE ${SYSTEM_FAILURE})::int AS failed,
          count(*) FILTER (WHERE c.status = 'missed' OR COALESCE(${CARRIER_OUTCOME}, false))::int AS unanswered
        FROM calls c JOIN users u ON u.id = c.user_id WHERE u.phone <> ALL($1)
          AND c.created_at >= now() - $2::interval AND c.created_at < now() - $3::interval`, range),
      queryOne(`SELECT COALESCE(sum(total_amount - tax_amount - refunded_amount), 0)::bigint AS cents FROM payments
        WHERE currency = 'usd' AND paid_at >= now() - $1::interval AND paid_at < now() - $2::interval`, [from, to]),
      // A new paying customer: their first plan payment falls in the window.
      queryOne(`SELECT count(*)::int AS n FROM (SELECT user_id, min(paid_at) AS first FROM payments
          WHERE product_key NOT LIKE 'credits%' GROUP BY user_id) f
        WHERE f.first >= now() - $1::interval AND f.first < now() - $2::interval`, [from, to]),
    ]);
    return {
      signups: signups.n, active: calls.active, connected: calls.connected, minutes: calls.minutes,
      new_paying: paying.n, usd_revenue_cents: num(revenue.cents),
      failure_rate: calls.total ? calls.failed / calls.total : 0,
      unanswered_rate: calls.total ? calls.unanswered / calls.total : 0,
    };
  };
  const [now, before] = await Promise.all([metrics(window(0)), metrics(window(1))]);
  const kpi = (id, title, better, unit) => ({ id, title, better, unit, now: now[id], before: before[id] });
  return { days, kpis: [
    kpi('signups', 'New sign-ups', 'up', 'count'),
    kpi('active', 'Active callers', 'up', 'count'),
    kpi('connected', 'Connected calls', 'up', 'count'),
    kpi('minutes', 'Call minutes', 'up', 'count'),
    kpi('new_paying', 'New paying customers', 'up', 'count'),
    kpi('usd_revenue_cents', 'Revenue (USD, net)', 'up', 'usd_cents'),
    kpi('failure_rate', 'Our call failure rate', 'down', 'rate'),
    kpi('unanswered_rate', 'Unanswered rate', 'down', 'rate'),
  ] };
}

export async function today(days) {
  const [checks, delta] = await Promise.all([health(), changes(days)]);
  const order = { fail: 0, warn: 1, info: 2, ok: 3 };
  return {
    generated_at: new Date().toISOString(),
    status: checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'ok',
    attention: checks.filter(c => c.status === 'fail' || c.status === 'warn').sort((a, b) => order[a.status] - order[b.status]),
    health: checks,
    changes: delta,
  };
}

/** Where people drop off, for accounts that signed up in the window. */
export async function funnel(days) {
  const row = await queryOne(`WITH cohort AS (
      SELECT u.id, u.terms_accepted_at,
        (SELECT count(*) FROM calls c WHERE c.user_id = u.id AND ${CONNECTED}) AS calls,
        EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status IN ${PAYING})
          OR EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.product_key NOT LIKE 'credits%') AS paying
      FROM users u WHERE u.phone <> ALL($1) AND u.created_at >= now() - make_interval(days => $2))
    -- Strict: each step counts only people who also passed every step before it.
    SELECT count(*)::int AS signed_up,
      count(*) FILTER (WHERE terms_accepted_at IS NOT NULL)::int AS accepted_terms,
      count(*) FILTER (WHERE terms_accepted_at IS NOT NULL AND calls >= 1)::int AS first_call,
      count(*) FILTER (WHERE terms_accepted_at IS NOT NULL AND calls >= 3)::int AS habit,
      count(*) FILTER (WHERE terms_accepted_at IS NOT NULL AND calls >= 3 AND paying)::int AS paying,
      count(*) FILTER (WHERE paying)::int AS paying_any
    FROM cohort`, [excludedPhones(), days]);
  const steps = [
    ['signed_up', 'Signed up'], ['accepted_terms', 'Accepted the terms'], ['first_call', 'Had a first real call'],
    ['habit', 'Made 3+ real calls'], ['paying', 'Paying'],
  ].map(([id, title], i, all) => ({ id, title, n: row[id], from_previous: i ? (row[all[i - 1][0]] ? row[id] / row[all[i - 1][0]] : null) : null }));
  // The bottleneck is the step that loses the largest share of the people who reached the one before it.
  const worst = steps.slice(1).filter(s => s.from_previous != null).sort((a, b) => a.from_previous - b.from_previous)[0];
  return { days, steps, bottleneck: worst?.id ?? null, paying_any: row.paying_any };
}

/** How calls are going: outcomes, why they fail, where they fail, and what we are running low on. */
export async function operations(days) {
  const x = excludedPhones();
  const [daily, outcomes, reasons, destinations, queue, pool, consent] = await Promise.all([
    query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, count(c.id)::int AS calls,
        count(c.id) FILTER (WHERE ${SYSTEM_FAILURE})::int AS failed,
        count(c.id) FILTER (WHERE c.status = 'missed' OR COALESCE(${CARRIER_OUTCOME}, false))::int AS unanswered
      FROM generate_series(current_date - ($2::int - 1), current_date, interval '1 day') day
      LEFT JOIN calls c ON c.created_at >= day AND c.created_at < day + interval '1 day'
        AND c.user_id IN (SELECT id FROM users WHERE phone <> ALL($1))
      GROUP BY day ORDER BY day`, [x, days]),
    queryOne(`SELECT count(*)::int AS total, count(*) FILTER (WHERE ${CONNECTED})::int AS connected,
        count(*) FILTER (WHERE c.status = 'ready')::int AS ready, count(*) FILTER (WHERE ${SYSTEM_FAILURE})::int AS failed,
        count(*) FILTER (WHERE c.status = 'missed' OR COALESCE(${CARRIER_OUTCOME}, false))::int AS unanswered,
        count(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound, count(*) FILTER (WHERE c.voicemail)::int AS voicemails,
        COALESCE(round(avg(c.duration_sec) FILTER (WHERE c.duration_sec > 0)), 0)::int AS avg_sec,
        COALESCE(round(sum(c.duration_sec) / 60.0), 0)::int AS minutes,
        count(*) FILTER (WHERE c.language LIKE 'am%')::int AS amharic
      FROM calls c JOIN users u ON u.id = c.user_id WHERE u.phone <> ALL($1) AND c.created_at > now() - make_interval(days => $2)`, [x, days]),
    query(`SELECT ${FAILURE_CATEGORY} AS reason, count(*)::int AS n FROM calls c JOIN users u ON u.id = c.user_id
      WHERE c.status = 'failed' AND u.phone <> ALL($1) AND c.created_at > now() - make_interval(days => $2)
      GROUP BY 1 ORDER BY 2 DESC`, [x, days]),
    // Read destinations only to derive a country code; numbers are never returned.
    query(`SELECT c.destination, c.status, ${SYSTEM_FAILURE} AS failed,
        (c.status = 'missed' OR COALESCE(${CARRIER_OUTCOME}, false)) AS unanswered
      FROM calls c JOIN users u ON u.id = c.user_id
      WHERE c.direction = 'outbound' AND u.phone <> ALL($1) AND c.created_at > now() - make_interval(days => $2)`, [x, days]),
    queryOne(`SELECT count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status IN ('initiating','ringing','in-progress'))::int AS live FROM calls WHERE deleted_at IS NULL`),
    queryOne(`SELECT count(*)::int AS total, count(*) FILTER (WHERE p.enabled AND u.id IS NULL)::int AS free,
        count(u.id)::int AS assigned FROM agent_number_pool p LEFT JOIN users u ON u.agent_number = p.phone`),
    queryOne(`SELECT count(*) FILTER (WHERE c.consent_mode = 'all_parties')::int AS asked,
        count(*) FILTER (WHERE c.consent_mode = 'all_parties' AND c.duration_sec > 0 AND NOT c.record_enabled)::int AS declined
      FROM calls c WHERE c.created_at > now() - make_interval(days => $1)`, [days]),
  ]);
  const byCountry = {};
  for (const call of destinations.rows) {
    const code = callingCode(call.destination) ?? 'other';
    const row = byCountry[code] ??= { country_code: code, calls: 0, failed: 0, unanswered: 0 };
    row.calls++; if (call.failed) row.failed++; if (call.unanswered) row.unanswered++;
  }
  return {
    generated_at: new Date().toISOString(),
    days,
    daily: daily.rows,
    outcomes,
    failure_reasons: reasons.rows,
    by_destination: Object.values(byCountry).sort((a, b) => b.calls - a.calls),
    queue,
    numbers: { ...pool, monthly_cost_usd: pool.total },
    consent,
  };
}
