import * as database from '../db/pool.js';

/**
 * Free accounts whose 30-day grace has ended give their business number
 * back. It goes to the back of the pool queue so it is not handed straight
 * to someone else while old contacts may still dial it (as on account
 * deletion). Runs daily from the retention cron.
 */
export async function releaseExpiredNumbers(db = database) {
  const { rows } = await db.query(`WITH released AS (
      SELECT id, agent_number FROM users
      WHERE number_release_at <= now() AND tier = 'free' AND agent_number IS NOT NULL
      FOR UPDATE
    ), pooled AS (
      UPDATE agent_number_pool SET checked_at = now() WHERE phone IN (SELECT agent_number FROM released) RETURNING phone
    )
    UPDATE users u SET agent_number = NULL, number_release_at = NULL
    FROM released r WHERE u.id = r.id RETURNING u.id`);
  return { released: rows.length };
}
