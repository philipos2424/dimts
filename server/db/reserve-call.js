import * as database from './pool.js';
import { HttpError } from '../lib/users.js';
import { config } from '../config.js';
import { isAccountSid } from '../lib/carrier.js';
import { recordingPolicy } from '../lib/recording-policy.js';
import { hasAcceptedTerms } from '../lib/terms.js';

function limit(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
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
  // Pending or uncertain calls reserve their entire cap. A definitively failed
  // request with no provider SID releases its minutes but still counts daily.
  const usage = (await db.query(`SELECT
    COALESCE(sum(CASE WHEN user_id=$1 THEN COALESCE(duration_sec, max_duration_sec) ELSE 0 END),0)::int AS owner_seconds,
    COALESCE(sum(COALESCE(duration_sec, max_duration_sec)),0)::int AS global_seconds
    FROM calls WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND NOT budget_released`, [user.id])).rows[0];
  const remaining = Math.min(limit('CALL_MINUTES_PER_MONTH', 120) * 60 - usage.owner_seconds,
    limit('GLOBAL_CALL_MINUTES_PER_MONTH', 300) * 60 - usage.global_seconds, 1800);
  if (remaining < 60) throw new HttpError(429, 'call_minutes_limit', 'Call minute limit reached.');
  const account = config.providerAccountSid;
  if (!isAccountSid(account)) throw new Error(`Invalid ${config.carrier === 'telnyx' ? 'TELNYX' : 'TWILIO'}_ACCOUNT_SID`);
  const contactId = options.contactId !== undefined ? options.contactId : (await db.query(`INSERT INTO contacts(user_id,phone) VALUES($1,$2)
    ON CONFLICT(user_id,phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id`, [user.id, destination])).rows[0].id;
  const policy = recordingPolicy(process.env, [user.phone, destination]);
  // Notice calls carry the owner's account-level consent on the owner's own leg.
  // Outgoing calls show the owner's own mobile once the carrier has verified it.
  const callerId = direction === 'outbound' && user.caller_id_verified_at ? user.phone : null;
  const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,record_enabled,request_key,max_duration_sec,status,direction,twilio_call_sid,agent_number,twilio_account_sid,consent_mode,consent_scope,
      parent_consent_at,child_consent_at,caller_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text,$10,$11,$12,$13::text,$14,
      CASE WHEN $13::text='notice' AND $5 AND $9::text='outbound' THEN now() END,
      CASE WHEN $13::text='notice' AND $5 AND $9::text='inbound' THEN now() END,$15) RETURNING *`,
    [user.id, user.phone, destination, contactId, record, requestKey, remaining, direction === 'inbound' ? 'ringing' : 'initiating', direction, options.callSid ?? null, user.agent_number ?? null, account, policy.mode, policy.scope, callerId])).rows[0];
  return { call, created: true };
}
