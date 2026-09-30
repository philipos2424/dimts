import * as database from './pool.js';
import { HttpError } from '../lib/users.js';

export function claimNumber(userId, voiceUrl) {
  return database.withTransaction(db => claimNumberInTransaction(db, userId, voiceUrl));
}

export async function claimNumberInTransaction(db, userId, voiceUrl) {
  const owner = (await db.query('SELECT id, phone, agent_number FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
  if (!owner) throw new HttpError(404, 'account_not_found');
  if (owner.agent_number) return { agent_number: owner.agent_number };
  const available = (await db.query(`SELECT p.phone FROM agent_number_pool p
    WHERE p.enabled AND p.voice_url=$1 AND p.phone<>$2
      AND NOT EXISTS(SELECT 1 FROM users u WHERE u.agent_number=p.phone OR u.phone=p.phone)
    ORDER BY p.checked_at, p.phone LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, [voiceUrl, owner.phone])).rows[0];
  if (!available) throw new HttpError(409, 'number_pool_empty', 'No business number is available yet. Your account is saved; try again after a number is added.');
  await db.query('UPDATE users SET agent_number=$2 WHERE id=$1', [userId, available.phone]);
  return { agent_number: available.phone };
}
