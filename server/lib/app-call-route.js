import { query, queryOne } from '../db/pool.js';
import { canAffordMinute } from '../db/reserve-call.js';
import { requiresExplicitConsent } from './destinations.js';
import { recordingPolicy } from './recording-policy.js';
import { hasAcceptedTerms } from './terms.js';
import { captureCallFailure } from './sentry.js';

const PHONE = { route: 'phone' };
const list = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);

/** Numbers whose calling code starts with one of these never use app calls. +251 by default. */
// Decide the fallback from the PARSED list: an empty, blank or comma-only value (a common way to "unset" on a host)
// must keep +251 blocked. Lifting the gate takes an explicit non-empty list of other prefixes.
const blockedPrefixes = () => { const parsed = list(process.env.APP_CALLS_BLOCKED_PREFIXES); return parsed.length ? parsed : ['251']; };
const blocked = number => blockedPrefixes().some(prefix => number.slice(1).startsWith(prefix));

/** Notice-mode recording only, and never where both people must press 1. */
const noticeOnly = numbers => !numbers.some(requiresExplicitConsent) && recordingPolicy(process.env, numbers).mode === 'notice';

/**
 * Whether a call to `destination` can go over the internet to another Dimts
 * user instead of over the phone network. Anything short of every condition
 * is the ordinary phone call; this never throws.
 */
export async function chooseRoute(caller, destination) {
  try {
    if (process.env.APP_CALLS_ENABLED !== 'true') return PHONE;
    if (typeof destination !== 'string' || !destination.startsWith('+') || destination === caller.phone) return PHONE;
    if (blocked(caller.phone) || blocked(destination) || !noticeOnly([caller.phone, destination])) return PHONE;
    if (!hasAcceptedTerms(caller)) return PHONE;
    const allowed = list(process.env.APP_CALLS_ALLOWLIST_USER_IDS);
    if (allowed.length && !allowed.includes(caller.id)) return PHONE;
    const callee = await queryOne('SELECT * FROM users WHERE phone=$1 AND deleted_at IS NULL', [destination]);
    if (!callee || !callee.app_calls_findable || !hasAcceptedTerms(callee)) return PHONE;
    if (allowed.length && !allowed.includes(callee.id)) return PHONE;
    const { rows } = await query(`SELECT 1 FROM notification_devices d JOIN sessions s ON s.token_hash=d.session_hash
      WHERE d.user_id=$1 AND NOT d.disabled AND d.app_calls_supported AND s.expires_at>now() LIMIT 1`, [callee.id]);
    if (!rows.length) return PHONE;
    const busy = await queryOne(`SELECT 1 AS busy FROM calls WHERE user_id=$1 AND deleted_at IS NULL
      AND status IN ('initiating','ringing','in-progress') LIMIT 1`, [callee.id]);
    if (busy) return PHONE;
    if (!(await canAffordMinute({ query }, callee))) return PHONE;
    return { route: 'app', callee };
  } catch (err) {
    captureCallFailure(err, { userId: caller?.id, stage: 'app-call-route' });
    return PHONE;
  }
}
