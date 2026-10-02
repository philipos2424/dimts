import * as database from './pool.js';
import { HttpError } from '../lib/users.js';
import { config } from '../config.js';
import { isTwilioAccount } from '../lib/recording-account.js';
import { recordingPolicy } from '../lib/recording-policy.js';

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
  const account = config.twilioAccountSid;
  if (!isTwilioAccount(account)) throw new Error('Invalid TWILIO_ACCOUNT_SID');
  const contactId = options.contactId !== undefined ? options.contactId : (await db.query(`INSERT INTO contacts(user_id,phone) VALUES($1,$2)
    ON CONFLICT(user_id,phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id`, [user.id, destination])).rows[0].id;
  const policy = recordingPolicy();
  const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,record_enabled,request_key,max_duration_sec,status,direction,twilio_call_sid,agent_number,twilio_account_sid,consent_mode,consent_scope)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [user.id, user.phone, destination, contactId, record, requestKey, remaining, direction === 'inbound' ? 'ringing' : 'initiating', direction, options.callSid ?? null, user.agent_number ?? null, account, policy.mode, policy.scope])).rows[0];
  return { call, created: true };
}
