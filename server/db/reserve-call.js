import * as database from './pool.js';
import { HttpError } from '../lib/users.js';
import { config } from '../config.js';
import { isAccountSid } from '../lib/carrier.js';
import { recordingPolicy } from '../lib/recording-policy.js';
import { hasAcceptedTerms } from '../lib/terms.js';
import { PLAN_SECONDS_SQL } from './plan-usage.js';
import { VOICEMAIL_MAX_SECONDS } from '../lib/recording-consent.js';
import { PLANS, affordableSeconds, callSurcharge, planOf, OVERAGE_CENTS_PER_MIN } from '../lib/pricing.js';

function limit(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * How long this call may last and what it may cost: plan minutes first, then
 * credits. Throws when neither can pay for a minute.
 */
async function callBudget(db, user, destination, direction, tier) {
  // Pending or uncertain calls reserve their whole cap. A definitively failed
  // request with no provider SID releases its minutes but still counts daily.
  // Finished calls count only the plan minutes they used (finish-call.js).
  const usage = (await db.query(`SELECT
    COALESCE(sum(CASE WHEN user_id=$1 THEN ${PLAN_SECONDS_SQL} ELSE 0 END),0)::int AS plan_seconds,
    COALESCE(sum(CASE WHEN COALESCE(billing_tier,'free')='free' THEN ${PLAN_SECONDS_SQL} ELSE 0 END),0)::int AS free_seconds
    FROM calls WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND NOT budget_released`, [user.id])).rows[0];
  const credits = (await db.query('SELECT COALESCE(sum(amount_cents),0)::int AS cents FROM credit_ledger WHERE user_id=$1', [user.id])).rows[0].cents;
  // The free plan's minutes come from one monthly pool shared by all free
  // users: a cost guard against sign-up farms. Credits are never held by it.
  const freePool = limit('GLOBAL_CALL_MINUTES_PER_MONTH', 300) * 60 - usage.free_seconds;
  const ownPlanSeconds = Math.max(0, PLANS[tier].minutes * 60 - usage.plan_seconds);
  const planSecondsLeft = tier === 'free' ? Math.min(ownPlanSeconds, Math.max(0, freePool)) : ownPlanSeconds;
  const surcharge = callSurcharge(user.phone, destination, direction);
  const remaining = affordableSeconds({ planSecondsLeft, credits, surcharge });
  if (remaining < 60) {
    if (ownPlanSeconds >= 60 && planSecondsLeft < 60 && surcharge === 0) throw new HttpError(429, 'call_minutes_limit', 'Call minute limit reached.');
    throw new HttpError(402, 'credits_required', surcharge > 0
      ? `Calls to this country cost ${surcharge} credits a minute. Add credits to call.`
      : "You have used this month's minutes. Add credits or upgrade to keep calling.");
  }
  return { remaining, planSeconds: Math.min(planSecondsLeft, remaining), surcharge };
}

export function reserveCall(user, destination, record, requestKey, options = {}) {
  return database.withTransaction(db => reserveCallInTransaction(db, user, destination, record, requestKey, options));
}

export async function reserveCallInTransaction(db, user, destination, record, requestKey, options = {}) {
  const direction = options.direction ?? 'outbound';
  // Recording consent comes from the owner's accepted terms. Without it an
  // outbound recorded call is refused; an inbound caller still gets through.
  if (record && !hasAcceptedTerms(user)) {
    if (direction === 'outbound') throw new HttpError(409, 'terms_required', 'Accept the terms to place recorded calls.');
    record = false;
  }
  // Serialize budget reads and reservations globally. Separate statements after
  // the lock see prior committed reservations under PostgreSQL READ COMMITTED.
  await db.query('SELECT id FROM call_budget_lock WHERE id=1 FOR UPDATE');
  const existing = (await db.query('SELECT * FROM calls WHERE user_id=$1 AND request_key=$2', [user.id, requestKey])).rows[0];
  if (existing) {
    if (existing.destination !== destination || existing.record_enabled !== record || existing.direction !== direction) throw new HttpError(409, 'request_key_reused', 'Use a new request key for a different call.');
    return { call: existing, created: false };
  }
  const active = (await db.query(`SELECT id FROM calls WHERE user_id=$1
    AND status IN ('initiating','ringing','in-progress') LIMIT 1`, [user.id])).rows[0];
  if (active) throw new HttpError(409, 'call_in_progress', 'Finish your current call before starting another.');
  const daily = (await db.query(`SELECT count(*)::int AS count FROM calls WHERE user_id=$1
    AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [user.id])).rows[0].count;
  if (daily >= limit('CALLS_PER_DAY', 10)) throw new HttpError(429, 'daily_call_limit', 'Daily call limit reached.');
  const tier = planOf(user);
  // A caller who reaches an owner with no minutes or credits left can still
  // leave a message: the call is recorded as missed, with voicemail, at no charge.
  const { remaining, planSeconds, surcharge } = options.voicemailOnly
    ? { remaining: VOICEMAIL_MAX_SECONDS, planSeconds: 0, surcharge: 0 }
    : await callBudget(db, user, destination, direction, tier);
  const account = config.providerAccountSid;
  if (!isAccountSid(account)) throw new Error(`Invalid ${config.carrier === 'telnyx' ? 'TELNYX' : 'TWILIO'}_ACCOUNT_SID`);
  const contactId = options.contactId !== undefined ? options.contactId : (await db.query(`INSERT INTO contacts(user_id,phone) VALUES($1,$2)
    ON CONFLICT(user_id,phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id`, [user.id, destination])).rows[0].id;
  const policy = recordingPolicy(process.env, [user.phone, destination]);
  // Notice calls carry the owner's account-level consent on the owner's own leg.
  const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,record_enabled,request_key,max_duration_sec,status,direction,twilio_call_sid,agent_number,twilio_account_sid,consent_mode,consent_scope,
      parent_consent_at,child_consent_at,billing_tier,plan_seconds,surcharge_cents,overage_cents)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text,$10,$11,$12,$13::text,$14,
      CASE WHEN $13::text='notice' AND $5 AND $9::text='outbound' THEN now() END,
      CASE WHEN $13::text='notice' AND $5 AND $9::text='inbound' THEN now() END,$15,$16,$17,$18) RETURNING *`,
    [user.id, user.phone, destination, contactId, record, requestKey, remaining, direction === 'inbound' ? 'ringing' : 'initiating', direction, options.callSid ?? null, user.agent_number ?? null, account, policy.mode, policy.scope,
      tier, planSeconds, surcharge, options.voicemailOnly ? 0 : OVERAGE_CENTS_PER_MIN])).rows[0];
  if (options.voicemailOnly) {
    const missed = (await db.query(`UPDATE calls SET status='missed', voicemail=true, duration_sec=0, completed_at=now()
      WHERE id=$1 RETURNING *`, [call.id])).rows[0];
    return { call: missed, created: true };
  }
  return { call, created: true };
}
