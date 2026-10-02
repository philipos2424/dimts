import { query, queryOne } from '../db/pool.js';
import { HttpError, hashToken } from './users.js';

/**
 * Count one request against `key` in a fixed window. Counters live in the
 * database so every Vercel function instance sees the same totals.
 */
export async function hit(key, max, windowSeconds) {
  const row = await queryOne(`INSERT INTO rate_limits(key,window_start,hits)
      VALUES($1, to_timestamp(floor(extract(epoch FROM now())/$2::int)*$2::int), 1)
    ON CONFLICT (key,window_start) DO UPDATE SET hits=rate_limits.hits+1
    RETURNING hits, ceil(extract(epoch FROM window_start + make_interval(secs => $2::int) - now()))::int AS remaining`,
  [hashToken(key), windowSeconds]);
  if (row.hits > max) {
    throw Object.assign(new HttpError(429, 'too_many_requests', 'Too many requests. Try again shortly.'),
      { retryAfter: Math.min(windowSeconds, Math.max(1, row.remaining)) });
  }
}

let lastSweep = 0;
function sweep() {
  if (Date.now() - lastSweep < 3_600_000) return;
  lastSweep = Date.now();
  query("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'")
    .catch(err => console.error('[rate-limit] sweep failed', err?.message));
}

/** 120/min per session, 30/min per IP without one. Mounted on /api only. */
export async function apiRateLimit(req, _res, next) {
  try {
    sweep();
    const bearer = req.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (bearer) await hit(`api-session:${bearer}`, 120, 60);
    else await hit(`api-ip:${req.ip}`, 30, 60);
    next();
  } catch (err) {
    if (err?.status === 429) return next(err);
    // A counter outage must not take the API down; authentication still applies.
    console.error('[rate-limit] counter unavailable', err?.message);
    next();
  }
}
