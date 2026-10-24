import express from 'express';
import { query, queryOne } from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';

export const promisesRouter = express.Router();

// Commitments come from each call's action items; only their status is stored.
// `due` is the deadline as said, in the owner's local time ("2026-10-08T12:00"
// or a bare date). `due_at` is that moment as an instant: the end of the day
// for a bare date. Overdue promises come first, then the soonest due.
export async function listPromises(userId, contactId = null) {
  // Action items are sealed at rest, so the database cannot unpack them: it picks
  // the calls and works out deadlines in the owner's time zone; the items are read here.
  const { rows: calls } = await query(`SELECT c.id AS call_id, c.contact_id, k.display_name AS contact_name,
      c.destination AS phone, c.created_at, c.action_items
    FROM calls c LEFT JOIN contacts k ON k.id = c.contact_id
    WHERE c.user_id=$1 AND c.status='ready' AND c.deleted_at IS NULL
      AND ($2::uuid IS NULL OR c.contact_id = $2::uuid)
      AND c.created_at > now() - interval '90 days' AND c.action_items IS NOT NULL
    ORDER BY c.created_at DESC`, [userId, contactId]);
  const items = calls.flatMap(({ action_items, ...call }) => (Array.isArray(action_items) ? action_items : [])
    .map((item, index) => ({ item, index, call }))
    .filter(({ item }) => item?.owner === 'User' || item?.owner === 'Caller'));
  const handled = items.length ? (await query(`SELECT call_id, item_index FROM promise_states
    WHERE call_id = ANY($1::uuid[]) AND status <> 'open'`, [[...new Set(items.map(({ call }) => call.call_id))]])).rows : [];
  const closed = new Set(handled.map(row => `${row.call_id}:${row.item_index}`));
  const open = items.filter(({ call, index }) => !closed.has(`${call.call_id}:${index}`));
  const dues = [...new Set(open.map(({ item }) => item.due).filter(due => typeof due === 'string'))];
  const instants = dues.length ? (await query(`WITH owner AS (SELECT coalesce(timezone, 'UTC') AS tz FROM users WHERE id=$1)
    SELECT due.value,
      CASE WHEN due.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' THEN due.value::timestamp AT TIME ZONE owner.tz
           WHEN due.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (due.value::date + 1)::timestamp AT TIME ZONE owner.tz END AS due_at
    FROM unnest($2::text[]) AS due(value) CROSS JOIN owner`, [userId, dues])).rows : [];
  const dueAt = new Map(instants.map(row => [row.value, row.due_at]));
  const rows = open.map(({ item, index, call }) => ({
    ...call, index, task: item.task == null ? null : String(item.task), owner: item.owner,
    due: typeof item.due === 'string' ? item.due : null, due_at: dueAt.get(item.due) ?? null,
  }));
  const now = Date.now();
  const shape = ({ owner, index, due_at, ...rest }) => {
    const at = due_at ? new Date(due_at) : null;
    return { ...rest, index: Number(index), due: rest.due ?? null, due_at: at ? at.toISOString() : null, overdue: !!at && at.getTime() < now };
  };
  const byUrgency = (a, b) => Number(b.overdue) - Number(a.overdue)
    || (a.due_at ? Date.parse(a.due_at) : Infinity) - (b.due_at ? Date.parse(b.due_at) : Infinity);
  return {
    you_owe: rows.filter(r => r.owner === 'User').map(shape).sort(byUrgency),
    waiting_on: rows.filter(r => r.owner === 'Caller').map(shape).sort(byUrgency),
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
  const call = await queryOne('SELECT id, action_items FROM calls WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
    [req.params.callId, user.id]);
  if (!call || !Array.isArray(call.action_items) || call.action_items.length <= index) throw new HttpError(404, 'promise_not_found');
  await query(`INSERT INTO promise_states(call_id,item_index,status) VALUES($1,$2,$3)
    ON CONFLICT (call_id,item_index) DO UPDATE SET status=EXCLUDED.status, updated_at=now()`, [call.id, index, status]);
  res.json({ status });
});
