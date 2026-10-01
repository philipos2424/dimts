import { queryOne } from './pool.js';

// Both writes form one SQL statement. If usage accounting fails, duration stays
// unclaimed so Twilio can safely retry. Duplicate callbacks claim no rows.
export const FINISH_CALL_SQL = `WITH changed AS (
  UPDATE calls SET duration_sec = $2, completed_at = now(),
    status = CASE WHEN deleted_at IS NOT NULL THEN 'deleted'
                  WHEN status = 'ready' THEN status
                  WHEN $3 AND record_enabled THEN 'processing'
                  WHEN $3 THEN 'completed' ELSE $5 END,
    error = CASE WHEN $3 THEN error ELSE $4 END
  WHERE id = $1 AND duration_sec IS NULL
  RETURNING id, user_id
), billed AS (
  INSERT INTO usage_minutes (user_id, month, minutes_used)
  SELECT user_id, $6, $2::numeric / 60 FROM changed WHERE $3 AND user_id IS NOT NULL
  ON CONFLICT (user_id, month) DO UPDATE
    SET minutes_used = usage_minutes.minutes_used + EXCLUDED.minutes_used
  RETURNING user_id
)
SELECT id, user_id FROM changed`;

export function finishCall(call, seconds, status, month) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('Invalid call duration');
  return queryOne(FINISH_CALL_SQL, [call.id, seconds, status === 'completed' && seconds > 0,
    `Dial ${status}`, call.direction === 'inbound' ? 'missed' : 'failed', month]);
}
