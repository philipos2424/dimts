import express from 'express';
import { query, queryOne } from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';

export const promisesRouter = express.Router();

// Commitments come from each call's action items; only their status is stored.
export async function listPromises(userId, contactId = null) {
  const { rows } = await query(`SELECT c.id AS call_id, item.ordinality - 1 AS index, item.value->>'task' AS task,
      item.value->>'owner' AS owner, c.contact_id, k.display_name AS contact_name, c.destination AS phone, c.created_at
    FROM calls c
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.action_items)='array' THEN c.action_items ELSE '[]'::jsonb END)
      WITH ORDINALITY AS item(value, ordinality)
    LEFT JOIN contacts k ON k.id = c.contact_id
    LEFT JOIN promise_states s ON s.call_id = c.id AND s.item_index = item.ordinality - 1
    WHERE c.user_id=$1 AND c.status='ready' AND c.deleted_at IS NULL
      AND ($2::uuid IS NULL OR c.contact_id = $2::uuid)
      AND c.created_at > now() - interval '90 days'
      AND item.value->>'owner' IN ('User','Caller') AND coalesce(s.status,'open')='open'
    ORDER BY c.created_at DESC, item.ordinality`, [userId, contactId]);
  const shape = ({ owner, index, ...rest }) => ({ ...rest, index: Number(index) });
  return {
    you_owe: rows.filter(r => r.owner === 'User').map(shape),
    waiting_on: rows.filter(r => r.owner === 'Caller').map(shape),
  };
}

promisesRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  res.json(await listPromises(user.id));
});

promisesRouter.post('/:callId/:index', async (req, res) => {
  const user = await resolveUser(req);
  const { status } = req.body ?? {};
  if (!['open', 'done', 'dismissed'].includes(status)) throw new HttpError(400, 'invalid_status');
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || !/^[0-9a-f-]{36}$/i.test(req.params.callId)) throw new HttpError(404, 'promise_not_found');
  const call = await queryOne(`SELECT id FROM calls WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
    AND jsonb_typeof(action_items)='array' AND jsonb_array_length(action_items) > $3`, [req.params.callId, user.id, index]);
  if (!call) throw new HttpError(404, 'promise_not_found');
  await query(`INSERT INTO promise_states(call_id,item_index,status) VALUES($1,$2,$3)
    ON CONFLICT (call_id,item_index) DO UPDATE SET status=EXCLUDED.status, updated_at=now()`, [call.id, index, status]);
  res.json({ status });
});
