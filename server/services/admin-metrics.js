/**
 * What the operator console measures. Read-only, and limited to account,
 * usage and billing metadata: Dimts is its customers' processor for what is
 * said on their calls (privacy policy, terms §processor), so nothing here
 * selects a transcript, summary, recap, note, contact name or recording.
 * Sealed columns appear only inside SQL tests that return true or false.
 * See docs/ADMIN.md for each metric's definition.
 */
import { randomUUID } from 'node:crypto';
import * as database from '../db/pool.js';

const query = (sql, params) => database.query(sql, params);
const queryOne = (sql, params) => database.queryOne(sql, params);
import * as pricing from '../lib/pricing.js';
import { TERMS_VERSION } from '../lib/terms.js';
import { reviewDemoPhone } from '../lib/review-demo.js';
import { HttpError } from '../lib/users.js';
import { recordingAuthorizationSql } from '../lib/recording-policy.js';
import { adminPhones, maskPhone, regionOf } from '../lib/admin.js';

// The App Store review account and staff's own accounts are not customers.
export const excludedPhones = () => [reviewDemoPhone(), ...adminPhones()].filter(Boolean);
const demo = excludedPhones;
const num = value => Number(value ?? 0);
// A call counts as "used" once someone spoke: it connected, or a caller left a voicemail.
// Demo calls are onboarding, not use: they never count as a real call.
export const CONNECTED = '(NOT c.demo AND (c.duration_sec > 0 OR c.voicemail))';
export const PAYING = "('active','trialing','past_due')";
const CHURNED = "('canceled','unpaid','revoked','incomplete_expired')";

/** List price of a subscription per month in US cents, from its Polar product key (e.g. pro_year). Retired `_lite` keys count at the list price. */
export function monthlyListCents(productKey) {
  const [plan, interval] = String(productKey).split('_');
  const cents = pricing.PLAN_PRICES.standard?.[plan]?.[interval]?.usd;
  if (cents == null) return 0;
  return interval === 'year' ? Math.round(cents / 12) : cents;
}

const countBy = (rows, key) => rows.reduce((out, row) => ({ ...out, [key(row)]: (out[key(row)] ?? 0) + 1 }), {});

export async function overview() {
  const d = demo();
  const [users, signups, active, appActive, callsDaily, outcomes, activation, trial, subs, churn, payments, credits, cost, carrier, adoption, top] = await Promise.all([
    query(`SELECT phone, tier, trial_ends_at, agent_number IS NOT NULL AS has_number FROM users WHERE deleted_at IS NULL AND phone <> ALL($1)`, [d]),
    query(`SELECT to_char(day,'YYYY-MM-DD') AS day, count(u.id)::int AS n
      FROM generate_series(current_date - 89, current_date, interval '1 day') day
      LEFT JOIN users u ON u.created_at >= day AND u.created_at < day + interval '1 day' AND u.phone <> ALL($1)
      GROUP BY day ORDER BY day`, [d]),
    queryOne(`SELECT count(DISTINCT c.user_id) FILTER (WHERE c.created_at > now() - interval '1 day')::int AS d1,
        count(DISTINCT c.user_id) FILTER (WHERE c.created_at > now() - interval '7 days')::int AS d7,
        count(DISTINCT c.user_id)::int AS d30
      FROM calls c JOIN users u ON u.id = c.user_id
      WHERE c.created_at > now() - interval '30 days' AND ${CONNECTED} AND u.deleted_at IS NULL AND u.phone <> ALL($1)`, [d]),
    queryOne(`SELECT count(DISTINCT s.user_id) FILTER (WHERE s.last_seen_at > now() - interval '1 day')::int AS d1,
        count(DISTINCT s.user_id) FILTER (WHERE s.last_seen_at > now() - interval '7 days')::int AS d7,
        count(DISTINCT s.user_id)::int AS d30
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.last_seen_at > now() - interval '30 days' AND u.phone <> ALL($1)`, [d]),
    query(`SELECT to_char(day,'YYYY-MM-DD') AS day, count(c.id)::int AS calls,
        count(c.id) FILTER (WHERE ${CONNECTED})::int AS connected,
        COALESCE(round(sum(c.duration_sec) / 60.0), 0)::int AS minutes
      FROM generate_series(current_date - 29, current_date, interval '1 day') day
      LEFT JOIN calls c ON c.created_at >= day AND c.created_at < day + interval '1 day'
        AND c.user_id IN (SELECT id FROM users WHERE phone <> ALL($1))
      GROUP BY day ORDER BY day`, [d]),
    queryOne(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE ${CONNECTED})::int AS connected,
        count(*) FILTER (WHERE c.status = 'missed')::int AS missed,
        count(*) FILTER (WHERE c.status = 'failed')::int AS failed,
        count(*) FILTER (WHERE c.status = 'ready')::int AS ready,
        count(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound,
        count(*) FILTER (WHERE c.voicemail)::int AS voicemails,
        count(*) FILTER (WHERE c.record_enabled AND c.duration_sec > 0)::int AS recorded,
        count(*) FILTER (WHERE c.consent_mode = 'all_parties')::int AS press1,
        count(*) FILTER (WHERE c.consent_mode = 'all_parties' AND c.duration_sec > 0 AND NOT c.record_enabled)::int AS press1_declined,
        COALESCE(round(avg(c.duration_sec) FILTER (WHERE c.duration_sec > 0)), 0)::int AS avg_sec,
        COALESCE(round(sum(c.duration_sec) / 60.0), 0)::int AS minutes,
        count(*) FILTER (WHERE c.language LIKE 'am%')::int AS amharic
      FROM calls c JOIN users u ON u.id = c.user_id
      WHERE c.created_at > now() - interval '30 days' AND u.phone <> ALL($1)`, [d]),
    // Of accounts old enough to judge, how many had a real call within a week of signing up.
    queryOne(`SELECT count(*)::int AS cohort,
        count(*) FILTER (WHERE first_call < u.created_at + interval '7 days')::int AS activated,
        COALESCE(round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY first_call - u.created_at)) / 3600), 0)::int AS median_hours
      FROM users u LEFT JOIN LATERAL (SELECT min(c.created_at) AS first_call FROM calls c
        WHERE c.user_id = u.id AND ${CONNECTED}) f ON true
      WHERE u.created_at BETWEEN now() - interval '90 days' AND now() - interval '7 days' AND u.phone <> ALL($1)`, [d]),
    queryOne(`SELECT count(*) FILTER (WHERE trial_ends_at IS NOT NULL)::int AS started,
        count(*) FILTER (WHERE trial_ends_at > now() AND tier = 'free' AND deleted_at IS NULL)::int AS active,
        count(*) FILTER (WHERE trial_ends_at <= now())::int AS ended,
        count(*) FILTER (WHERE trial_ends_at <= now() AND tier IN ('pro','business'))::int AS converted_after_end,
        count(*) FILTER (WHERE trial_ends_at IS NOT NULL AND tier IN ('pro','business'))::int AS converted
      FROM users WHERE phone <> ALL($1)`, [d]),
    query(`SELECT s.product_key, s.plan, s.billing_interval, s.status, s.cancel_at_period_end
      FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.status IN ${PAYING} AND u.phone <> ALL($1)`, [d]),
    queryOne(`SELECT count(*) FILTER (WHERE status IN ${CHURNED} AND updated_at > now() - interval '30 days')::int AS churned_30d,
        count(*) FILTER (WHERE status IN ${PAYING} AND cancel_at_period_end)::int AS cancelling,
        count(*) FILTER (WHERE status = 'past_due')::int AS past_due
      FROM subscriptions`),
    query(`SELECT currency, product_key LIKE 'credits%' AS credits, count(*)::int AS orders,
        sum(total_amount)::bigint AS gross, sum(tax_amount)::bigint AS tax, sum(refunded_amount)::bigint AS refunded
      FROM payments WHERE paid_at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1, 2`),
    queryOne(`SELECT COALESCE(sum(l.amount_cents) FILTER (WHERE u.deleted_at IS NULL), 0)::bigint AS outstanding,
        COALESCE(sum(l.amount_cents) FILTER (WHERE l.reason = 'purchase' AND l.created_at > now() - interval '30 days'), 0)::bigint AS bought_30d,
        COALESCE(-sum(l.amount_cents) FILTER (WHERE l.reason = 'call' AND l.created_at > now() - interval '30 days'), 0)::bigint AS used_30d,
        COALESCE(sum(l.amount_cents) FILTER (WHERE l.reason = 'grant' AND l.created_at > now() - interval '30 days'), 0)::bigint AS granted_30d
      FROM credit_ledger l JOIN users u ON u.id = l.user_id`),
    queryOne(`SELECT COALESCE(sum(est_cost_micros), 0)::bigint AS micros FROM calls WHERE created_at > now() - interval '30 days'`),
    query(`SELECT country_code, sum(records)::int AS records, round(sum(billed_sec) / 60.0)::int AS minutes, sum(cost_micros)::bigint AS micros
      FROM provider_costs WHERE day > current_date - 30 GROUP BY 1 ORDER BY micros DESC`),
    queryOne(`SELECT count(*) FILTER (WHERE caller_id_verified_at IS NOT NULL)::int AS caller_id,
        count(*) FILTER (WHERE language = 'am')::int AS amharic,
        count(*) FILTER (WHERE terms_version = $2)::int AS terms_current,
        count(*) FILTER (WHERE retention_months IS NULL)::int AS keep_forever,
        count(*) FILTER (WHERE retention_months = 3)::int AS keep_3,
        count(*) FILTER (WHERE retention_months = 6)::int AS keep_6,
        count(*) FILTER (WHERE retention_months = 12)::int AS keep_12,
        count(*) FILTER (WHERE retention_months = 24)::int AS keep_24,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM google_connections g WHERE g.user_id = users.id AND g.kind = 'calendar'))::int AS calendar,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM google_connections g WHERE g.user_id = users.id AND g.kind = 'gmail'))::int AS gmail,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM notification_devices n WHERE n.user_id = users.id AND NOT n.disabled))::int AS push
      FROM users WHERE deleted_at IS NULL AND phone <> ALL($1)`, [d, TERMS_VERSION]),
    query(`SELECT u.id, u.phone, u.tier, count(c.id)::int AS calls, round(sum(c.duration_sec) / 60.0)::int AS minutes
      FROM calls c JOIN users u ON u.id = c.user_id
      WHERE c.created_at > now() - interval '30 days' AND c.duration_sec > 0 AND u.deleted_at IS NULL AND u.phone <> ALL($1)
      GROUP BY u.id ORDER BY minutes DESC LIMIT 10`, [d]),
  ]);

  const accounts = users.rows;
  const onTrial = row => row.tier === 'free' && row.trial_ends_at && new Date(row.trial_ends_at) > new Date();
  const mrrCents = subs.rows.reduce((sum, row) => sum + monthlyListCents(row.product_key), 0);
  const payingUsers = subs.rows.length;
  const usd = payments.rows.filter(row => row.currency === 'usd');
  const usdNet = usd.reduce((sum, row) => sum + num(row.gross) - num(row.tax) - num(row.refunded), 0);
  const carrierMicros = carrier.rows.reduce((sum, row) => sum + num(row.micros), 0);

  return {
    generated_at: new Date().toISOString(),
    accounts: {
      total: accounts.length,
      by_plan: countBy(accounts, row => (onTrial(row) ? 'trial' : row.tier)),
      by_region: countBy(accounts, row => regionOf(row.phone)),
      with_business_number: accounts.filter(row => row.has_number).length,
      deleted: num((await queryOne('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NOT NULL')).n),
    },
    signups_daily: signups.rows,
    active: { calls: active, app: appActive },
    calls_daily: callsDaily.rows,
    calls_30d: outcomes,
    activation,
    trial: { ...trial, days: pricing.TRIAL_DAYS ?? null },
    revenue: {
      mrr_usd_cents: mrrCents,
      paying_users: payingUsers,
      arppu_usd_cents: payingUsers ? Math.round(mrrCents / payingUsers) : 0,
      plans: countBy(subs.rows, row => `${row.plan} · ${row.billing_interval}`),
      ...churn,
      churn_rate_30d: payingUsers + churn.churned_30d ? churn.churned_30d / (payingUsers + churn.churned_30d) : 0,
      payments_30d: payments.rows,
    },
    credits,
    unit_economics: {
      usd_net_revenue_cents_30d: usdNet,
      estimated_call_cost_micros_30d: num(cost.micros),
      carrier_billed_micros_30d: carrierMicros,
      carrier_by_country: carrier.rows,
    },
    adoption,
    top_accounts: top.rows.map(({ phone, ...row }) => ({ ...row, phone: maskPhone(phone), region: regionOf(phone) })),
  };
}

/** Weekly signup cohorts: of the accounts created in a week, how many had a real call in each following week. */
export async function cohorts({ weeks = 8 } = {}) {
  const d = demo();
  const sizes = await query(`SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, count(*)::int AS size
    FROM users WHERE created_at >= date_trunc('week', now()) - make_interval(weeks => $2) AND phone <> ALL($1)
    GROUP BY 1 ORDER BY 1`, [d, weeks - 1]);
  const activity = await query(`SELECT to_char(date_trunc('week', u.created_at), 'YYYY-MM-DD') AS week,
      floor(extract(epoch FROM (c.created_at - date_trunc('week', u.created_at))) / 604800)::int AS k,
      count(DISTINCT u.id)::int AS n
    FROM users u JOIN calls c ON c.user_id = u.id AND ${CONNECTED}
    WHERE u.created_at >= date_trunc('week', now()) - make_interval(weeks => $2) AND u.phone <> ALL($1)
    GROUP BY 1, 2`, [d, weeks - 1]);
  return sizes.rows.map(row => {
    const elapsed = Math.floor((Date.now() - new Date(`${row.week}T00:00:00Z`).getTime()) / 604_800_000);
    return { ...row, weeks: Array.from({ length: elapsed + 1 }, (_, k) =>
      activity.rows.find(cell => cell.week === row.week && cell.k === k)?.n ?? 0) };
  });
}

/**
 * Dimts' own legal promises, checked against live data. Each check says what
 * the rule is, where it comes from, and how many records break it now.
 */
export async function compliance() {
  const one = (sql, params) => queryOne(sql, params).then(row => num(row?.n));
  const [overdue, dueSoon, retention, deletion, archive, unauthorized, plaintext, auditOld, staleTerms, reveals] = await Promise.all([
    one(`SELECT count(*)::int AS n FROM privacy_request_targets t JOIN privacy_requests r ON r.id = t.request_id
      WHERE t.resolved_at IS NULL AND r.created_at < now() - interval '30 days'`),
    one(`SELECT count(*)::int AS n FROM privacy_request_targets t JOIN privacy_requests r ON r.id = t.request_id
      WHERE t.resolved_at IS NULL AND r.created_at BETWEEN now() - interval '30 days' AND now() - interval '23 days'`),
    // The cron runs daily; two days' slack keeps one missed run from raising an alarm.
    one(`SELECT count(*)::int AS n FROM calls c JOIN users u ON u.id = c.user_id
      WHERE u.retention_months IS NOT NULL AND u.deleted_at IS NULL AND c.deleted_at IS NULL
        AND c.created_at < now() - make_interval(months => u.retention_months) - interval '2 days'`),
    one(`SELECT count(*)::int AS n FROM calls WHERE deleted_at < now() - interval '1 day'
      AND (provider_deletion_status IN ('pending','unknown','failed') OR storage_deletion_status IN ('pending','unknown','failed'))`),
    one(`SELECT count(*)::int AS n FROM calls WHERE deleted_at IS NULL AND recording_url IS NOT NULL
      AND audio_object_key IS NULL AND created_at < now() - interval '1 day' AND status IN ('ready','failed')`),
    one(`SELECT count(*)::int AS n FROM calls WHERE (audio_object_key IS NOT NULL OR recording_url IS NOT NULL OR recording_sid IS NOT NULL)
      AND deleted_at IS NULL AND NOT COALESCE(${recordingAuthorizationSql}, false)`),
    one(`SELECT (SELECT count(*) FROM calls WHERE deleted_at IS NULL AND (
        (transcript IS NOT NULL AND transcript NOT LIKE 'dmt1.%') OR (summary IS NOT NULL AND summary NOT LIKE 'dmt1.%')))
      + (SELECT count(*) FROM contacts WHERE notes IS NOT NULL AND notes <> '' AND notes NOT LIKE 'dmt1.%') AS n`),
    one(`SELECT count(*)::int AS n FROM audit_events WHERE created_at < now() - interval '1 year'`),
    one(`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL AND terms_version IS DISTINCT FROM $1`, [TERMS_VERSION]),
    one(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'admin_revealed_phone' AND created_at > now() - interval '30 days'`),
  ]);
  const check = (id, title, rule, source, count, level = 'fail', action) =>
    ({ id, title, rule, source, count, status: count ? level : 'ok', action: count ? action : null });
  return {
    generated_at: new Date().toISOString(),
    checks: [
      check('privacy_overdue', 'Deletion requests from people who were recorded', 'Answered within 30 days',
        'GDPR Art. 12(3), 17 · UK GDPR · CCPA §1798.105 · Privacy policy "Your rights"', overdue, 'fail',
        'The account owner has not acted. Remind them; if they do not respond, act as processor on their documented instructions or escalate to privacy@dimts.app.'),
      check('privacy_due_soon', 'Deletion requests due within 7 days', 'Warn before the 30-day deadline',
        'GDPR Art. 12(3)', dueSoon, 'warn', 'Send the owner a reminder (scripts/privacy-requests.js lists them).'),
      check('retention', 'Calls kept past the owner\'s retention period', 'Deleted automatically at the chosen period',
        'GDPR Art. 5(1)(e) storage limitation · Privacy policy "How long we keep it"', retention, 'fail',
        'Check that the daily /api/cron/retention job runs and look for skipped calls in its logs.'),
      check('deletion_backlog', 'Deleted calls whose audio is still stored', 'Removed from storage and the carrier after deletion',
        'GDPR Art. 17 · Privacy policy "Deleted recordings are removed"', deletion, 'fail',
        'Re-run processDeletion for these calls; check carrier and storage credentials.'),
      check('archive_backlog', 'Recordings still held only by the carrier', 'Audio moved to EU storage (Ireland)',
        'GDPR Art. 44-46 transfers · Privacy policy "Where your data lives"', archive, 'warn',
        'Archive retries run when the owner opens the app; investigate upload failures.'),
      check('recording_authorization', 'Recordings without a notice or required consent', 'Notice before recording; press-1 consent in DE, AT and the Gulf',
        'Wiretap and one/all-party consent laws · StGB §201 (DE) · §120 (AT) · UAE/KSA privacy law', unauthorized, 'fail',
        'Stop and investigate immediately: delete the affected recordings and find the code path that skipped the consent gate.'),
      check('encryption', 'Call content stored without encryption', 'Transcripts, summaries and notes sealed with a per-account key',
        'GDPR Art. 32 · Privacy policy "Security"', plaintext, process.env.DATA_ENCRYPTION_KEYS ? 'fail' : 'info',
        'The nightly retention job (02:30 UTC) seals these in batches. If the count is still above 0 the next day, a code path is writing plaintext: find it, or run server/scripts/encrypt-existing.js --dry-run to list the rows.'),
      check('audit_retention', 'Activity-log entries older than one year', 'Kept for one year',
        'Privacy policy "How long we keep it" · GDPR Art. 5(1)(e)', auditOld, 'warn',
        'The daily retention job removes them; check that it runs.'),
      check('terms', 'Active accounts on older terms', 'Owners accept the current terms before their next call',
        `Terms version ${TERMS_VERSION}`, staleTerms, 'info', 'Shown to owners at next sign-in; no action needed.'),
      check('staff_access', 'Staff phone-number reveals in the last 30 days', 'Each with a stated reason, visible to the customer',
        'GDPR Art. 5(2) accountability · Art. 32(4) staff access', reveals, 'info', 'Review the access log for anything unexpected.'),
    ],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Find accounts. Search takes an exact phone number (a customer telling
 * support their number), the last four digits, or the start of an account
 * ID — never a partial number, which would turn search into enumeration.
 */
export async function customers({ q = '', plan = '', page = 0 } = {}) {
  const where = ['u.phone <> ALL($1)'];
  const params = [demo()];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  const search = String(q).trim().replace(/[\s()-]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(search)) add('u.phone = ?', search);
  else if (/^\d{4}$/.test(search)) add('right(u.phone, 4) = ?', search);
  else if (/^[0-9a-f]{4,36}$/i.test(search)) add('u.id::text LIKE ?', `${search.toLowerCase()}%`);
  else if (search) return { customers: [], page: 0, has_more: false };
  if (plan === 'trial') where.push("u.tier = 'free' AND u.trial_ends_at > now() AND u.deleted_at IS NULL");
  else if (plan === 'deleted') where.push('u.deleted_at IS NOT NULL');
  else if (['free', 'pro', 'business'].includes(plan)) add('u.tier = ? AND u.deleted_at IS NULL', plan);
  const offset = Math.max(0, Math.min(Number(page) || 0, 1000)) * 50;
  const { rows } = await query(`SELECT u.id, u.phone, u.tier, u.trial_ends_at, u.created_at, u.deleted_at,
      u.agent_number IS NOT NULL AS has_number,
      (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
      (SELECT count(*) FROM calls c WHERE c.user_id = u.id AND c.created_at > now() - interval '30 days' AND ${CONNECTED})::int AS calls_30d,
      (SELECT COALESCE(round(sum(c.duration_sec) / 60.0), 0) FROM calls c WHERE c.user_id = u.id AND c.created_at > now() - interval '30 days')::int AS minutes_30d,
      (SELECT COALESCE(sum(l.amount_cents), 0) FROM credit_ledger l WHERE l.user_id = u.id)::int AS credits,
      (SELECT s.status FROM subscriptions s WHERE s.user_id = u.id ORDER BY s.updated_at DESC LIMIT 1) AS subscription
    FROM users u WHERE ${where.join(' AND ')}
    ORDER BY u.created_at DESC LIMIT 51 OFFSET ${offset}`, params);
  return {
    customers: rows.slice(0, 50).map(({ phone, ...row }) => ({ ...row, phone: maskPhone(phone), region: regionOf(phone) })),
    page: offset / 50,
    has_more: rows.length > 50,
  };
}

async function findUser(id) {
  if (!UUID.test(String(id))) throw new HttpError(404, 'not_found');
  const user = await queryOne(`SELECT id, phone, tier, trial_ends_at, created_at, deleted_at, agent_number, number_release_at,
      language, timezone, retention_months, terms_version, terms_accepted_at, caller_id_verified_at
    FROM users WHERE id = $1`, [id]);
  if (!user) throw new HttpError(404, 'not_found');
  return user;
}

/** One account's metadata for support. No call content, contacts or numbers they called. */
export async function customerDetail(id) {
  const { phone, agent_number: agentNumber, ...user } = await findUser(id);
  const [months, outcomes, subscriptions, payments, ledger, devices, google, privacy, activity] = await Promise.all([
    query(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, count(*)::int AS calls,
        count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
        COALESCE(round(sum(duration_sec) / 60.0), 0)::int AS minutes,
        COALESCE(sum(est_cost_micros), 0)::bigint AS cost_micros
      FROM calls WHERE user_id = $1 AND created_at > now() - interval '12 months' GROUP BY 1 ORDER BY 1 DESC`, [id]),
    query(`SELECT status, count(*)::int AS n FROM calls WHERE user_id = $1 AND created_at > now() - interval '90 days' GROUP BY 1 ORDER BY 2 DESC`, [id]),
    query(`SELECT product_key, plan, billing_interval, status, current_period_end, cancel_at_period_end, updated_at
      FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC`, [id]),
    query(`SELECT product_key, currency, total_amount, tax_amount, refunded_amount, paid_at
      FROM payments WHERE user_id = $1 ORDER BY paid_at DESC LIMIT 50`, [id]),
    query(`SELECT amount_cents, reason, created_at, sum(amount_cents) OVER () AS balance
      FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    queryOne(`SELECT count(*)::int AS sessions, max(last_seen_at) AS last_seen_at FROM sessions WHERE user_id = $1 AND expires_at > now()`, [id]),
    query('SELECT kind, connected_at FROM google_connections WHERE user_id = $1', [id]),
    queryOne(`SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open, count(*)::int AS total
      FROM privacy_request_targets WHERE user_id = $1`, [id]),
    query(`SELECT action, created_at FROM audit_events WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`, [id]),
  ]);
  return {
    ...user,
    phone: maskPhone(phone),
    region: regionOf(phone),
    has_business_number: !!agentNumber,
    usage_by_month: months.rows,
    calls_by_status_90d: outcomes.rows,
    subscriptions: subscriptions.rows,
    payments: payments.rows,
    credits: { balance: num(ledger.rows[0]?.balance), entries: ledger.rows.map(({ balance, ...row }) => row) },
    devices,
    google: google.rows,
    privacy_requests: privacy,
    activity: activity.rows,
  };
}

/** The full number, for support that must reach the person. The caller audits it. */
export async function customerPhone(id) {
  const user = await findUser(id);
  if (user.deleted_at) throw new HttpError(410, 'account_deleted', 'This account was deleted; its number is gone.');
  return user.phone;
}

export const MAX_GRANT_CENTS = 5000;

/** Goodwill credits (a failed call, a billing mistake). Capped per grant; each is a ledger row the owner sees. */
export async function grantCredits(id, cents) {
  const amount = Number(cents);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_GRANT_CENTS) {
    throw new HttpError(400, 'invalid_amount', `Grant between 1 and ${MAX_GRANT_CENTS} credits.`);
  }
  const user = await findUser(id);
  if (user.deleted_at) throw new HttpError(410, 'account_deleted');
  return database.withTransaction(async tx => {
    await tx.query(`INSERT INTO credit_ledger(user_id, amount_cents, reason, source_key) VALUES($1, $2, 'grant', $3)`,
      [id, amount, `admin-grant:${randomUUID()}`]);
    const { rows: [row] } = await tx.query('SELECT COALESCE(sum(amount_cents), 0)::int AS balance FROM credit_ledger WHERE user_id = $1', [id]);
    return { balance: row.balance };
  });
}

/** Every staff action, newest first: the record that shows staff access is limited and justified. */
export async function accessLog() {
  const { rows } = await query(`SELECT a.created_at, a.action, a.target_type, a.target_id, a.reason, u.phone
    FROM audit_events a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.action LIKE 'admin\\_%' ORDER BY a.created_at DESC, a.id DESC LIMIT 300`);
  return { events: rows.map(({ phone, ...row }) => ({ ...row, staff: maskPhone(phone) })) };
}

/**
 * Marketing-site waitlist. Visitors gave these emails to hear about the apps,
 * so unlike customer data they are shown in full. `source` is the form plus
 * the link's ?ref= ("home-hero:linkedin"); the part after the colon is the channel.
 */
export async function waitlist() {
  const [totals, channels, platforms, days, people] = await Promise.all([
    query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last_7d,
      count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS last_24h FROM waitlist`),
    query(`SELECT COALESCE(NULLIF(split_part(source, ':', 2), ''), 'direct') AS channel, count(*)::int AS n
      FROM waitlist GROUP BY 1 ORDER BY 2 DESC, 1`),
    query(`SELECT COALESCE(platform, 'not given') AS platform, count(*)::int AS n FROM waitlist GROUP BY 1 ORDER BY 2 DESC`),
    query(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM waitlist WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`),
    query('SELECT email, platform, work, country, source, created_at FROM waitlist ORDER BY created_at DESC LIMIT 5000'),
  ]);
  return { ...totals.rows[0], channels: channels.rows, platforms: platforms.rows, days: days.rows, people: people.rows };
}
