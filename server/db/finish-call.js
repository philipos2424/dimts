import { queryOne } from './pool.js';

// All writes form one SQL statement. If usage accounting fails, duration stays
// unclaimed so Twilio can safely retry. Duplicate callbacks claim no rows.
// Plan minutes shrink to the real call length; credits are charged per started
// minute at the rates fixed when the call was reserved (lib/pricing.js).
export const FINISH_CALL_SQL = `WITH changed AS (
  UPDATE calls SET duration_sec = $2, completed_at = now(),
    plan_seconds = CASE WHEN $3 THEN LEAST(COALESCE(plan_seconds, $2), $2) ELSE 0 END,
    status = CASE WHEN deleted_at IS NOT NULL THEN 'deleted'
                  WHEN status = 'ready' THEN status
                  WHEN $3 AND record_enabled THEN 'processing'
                  WHEN $3 THEN 'completed' ELSE $5 END,
    error = CASE WHEN $3 THEN error ELSE $4 END
  WHERE id = $1 AND duration_sec IS NULL
  RETURNING id, user_id, plan_seconds, surcharge_cents, overage_cents
), billed AS (
  INSERT INTO usage_minutes (user_id, month, minutes_used)
  SELECT user_id, $6, $2::numeric / 60 FROM changed WHERE $3 AND user_id IS NOT NULL
  ON CONFLICT (user_id, month) DO UPDATE
    SET minutes_used = usage_minutes.minutes_used + EXCLUDED.minutes_used
  RETURNING user_id
), charged AS (
  INSERT INTO credit_ledger (user_id, amount_cents, reason, source_key)
  SELECT user_id, -cost, 'call', 'call:' || id FROM (
    SELECT id, user_id, (ceil($2::numeric / 60) * surcharge_cents
      + ceil(GREATEST($2 - plan_seconds, 0)::numeric / 60) * overage_cents)::int AS cost
    FROM changed WHERE $3 AND user_id IS NOT NULL) priced
  WHERE cost > 0
  ON CONFLICT (source_key) DO NOTHING
  RETURNING user_id
)
SELECT id, user_id FROM changed`;

export function finishCall(call, seconds, status, month) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('Invalid call duration');
  return queryOne(FINISH_CALL_SQL, [call.id, seconds, status === 'completed' && seconds > 0,
    `Dial ${status}`, call.direction === 'inbound' ? 'missed' : 'failed', month]);
}
