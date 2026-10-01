import { query, queryOne } from './pool.js';

export async function contactContext(userId, phone, { before = null, exclude = null } = {}) {
  const contact = await queryOne(`SELECT id, phone, display_name, company, notes
    FROM contacts WHERE user_id=$1 AND phone=$2`, [userId, phone]);
  const { rows } = await query(`SELECT id, created_at, direction, summary, key_points, action_items, next_moves
    FROM calls WHERE user_id=$1 AND destination=$2 AND status='ready' AND summary IS NOT NULL
      AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)
      AND ($4::uuid IS NULL OR id <> $4::uuid)
    ORDER BY created_at DESC, id DESC LIMIT 5`, [userId, phone, before, exclude]);
  return { contact: contact ?? null, previous_calls: rows };
}
