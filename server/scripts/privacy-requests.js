// Operator view: privacy requests a business has not resolved within 25 days.
// Usage: node --env-file=../.env scripts/privacy-requests.js
import { query, closeDatabase } from '../db/pool.js';

const { rows } = await query(`SELECT r.id, r.created_at, r.created_at + interval '30 days' AS due_at,
    u.id AS user_id, u.agent_number
  FROM privacy_request_targets t JOIN privacy_requests r ON r.id = t.request_id JOIN users u ON u.id = t.user_id
  WHERE t.resolved_at IS NULL AND r.created_at < now() - interval '25 days'
  ORDER BY r.created_at`);
if (!rows.length) console.log('No privacy requests are close to overdue.');
for (const row of rows) console.log(`${row.id}  user ${row.user_id} (${row.agent_number ?? 'no number'})  due ${row.due_at.toISOString().slice(0, 10)}`);
await closeDatabase();
