import { queryOne } from '../db/pool.js';
import { createHash } from 'node:crypto';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Resolve only a server-issued, unexpired session created after phone OTP.
 */
export async function resolveUser(req) {
  const token = req.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if (!token) throw new HttpError(401, 'authentication_required');
  const hash = hashToken(token);
  const user = await queryOne(
    `SELECT u.id, u.phone, u.tier, u.agent_number, u.terms_version, u.language, u.retention_months, u.caller_id_verified_at, u.trial_ends_at, u.timezone,
            s.id AS session_id, (s.last_seen_at IS NULL OR s.last_seen_at < now() - interval '10 minutes') AS session_stale
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.deleted_at IS NULL`,
    [hash]
  );
  if (!user) throw new HttpError(401, 'session_expired');
  const { session_id: sessionId, session_stale: stale } = user;
  delete user.session_id; delete user.session_stale;
  // "Last active" for Settings › Signed-in devices, written at most every ten minutes.
  if (stale) await queryOne('UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 RETURNING id', [hash]);
  Object.defineProperty(user, 'sessionId', { value: sessionId, enumerable: false });
  return user;
}

/** 'YYYY-MM' in UTC, matching usage_minutes.month. */
export function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}
