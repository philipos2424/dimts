import * as database from './pool.js';
import { config } from '../config.js';
import { HttpError } from '../lib/users.js';
import { buyPoolNumber, countryFor, numberCountryUnavailable } from '../services/provision-number.js';

/** Where business numbers send incoming calls; null until public HTTPS routing is configured. */
export function incomingVoiceUrl() {
  if (!process.env.PUBLIC_BASE_URL) return null;
  return new URL(config.publicBaseUrl).protocol === 'https:' ? `${config.publicBaseUrl}/twiml/incoming` : null;
}

/**
 * Give the user a business number: the oldest free one in the pool, or, when
 * the pool is empty, one bought from the carrier on the spot. The purchase
 * happens outside the claim transaction so a slow carrier never holds a lock,
 * and a bought number is committed to the pool before anyone claims it.
 */
export async function claimNumber(userId, voiceUrl, { buy = buyPoolNumber } = {}) {
  const claim = () => database.withTransaction(db => claimNumberInTransaction(db, userId, voiceUrl));
  try {
    return await claim();
  } catch (err) {
    if (err?.code !== 'number_pool_empty') throw err;
    const owner = await database.queryOne('SELECT phone FROM users WHERE id=$1', [userId]);
    let bought;
    try {
      bought = await buy({ userId, ownerPhone: owner?.phone, voiceUrl });
    } catch (buyErr) {
      if (buyErr instanceof HttpError) throw buyErr;
      // A carrier outage or missing credentials: the owner sees the plain pool message, operators see the log.
      console.error('[numbers] purchase failed:', buyErr?.message);
    }
    if (!bought) throw err;
    return claim();
  }
}

export async function claimNumberInTransaction(db, userId, voiceUrl) {
  const owner = (await db.query('SELECT id, phone, agent_number FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
  if (!owner) throw new HttpError(404, 'account_not_found');
  if (owner.agent_number) return { agent_number: owner.agent_number };
  // The pool holds numbers from the countries we sell in; never hand one to an owner elsewhere.
  if (!countryFor(owner.phone)) throw numberCountryUnavailable();
  const available = (await db.query(`SELECT p.phone FROM agent_number_pool p
    WHERE p.enabled AND p.voice_url=$1 AND p.phone<>$2
      AND (p.available_after IS NULL OR p.available_after <= now())
      AND NOT EXISTS(SELECT 1 FROM users u WHERE u.agent_number=p.phone OR u.phone=p.phone)
    ORDER BY p.checked_at, p.phone LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, [voiceUrl, owner.phone])).rows[0];
  if (!available) throw new HttpError(409, 'number_pool_empty', 'No business number is available yet. Your account is saved; try again after a number is added.');
  await db.query('UPDATE users SET agent_number=$2 WHERE id=$1', [userId, available.phone]);
  return { agent_number: available.phone };
}
