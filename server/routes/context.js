import express from 'express';
import { queryOne, query } from '../db/pool.js';
import { contactContext } from '../db/call-context.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { isE164 } from '../lib/phone.js';

export const contextRouter = express.Router();
contextRouter.get('/contacts/context', async (req, res) => {
  const user = await resolveUser(req);
  if (!isE164(req.query.phone)) throw new HttpError(400, 'invalid_phone');
  res.json(await contactContext(user.id, req.query.phone));
});
contextRouter.get('/calls/incoming/active', async (req, res) => {
  const user = await resolveUser(req);
  const { rows } = await query(`SELECT id, destination, status, created_at FROM calls
    WHERE user_id=$1 AND direction='inbound' AND status IN ('ringing','in-progress')
      AND duration_sec IS NULL AND created_at > now() - interval '35 minutes'
    ORDER BY created_at DESC LIMIT 1`, [user.id]);
  res.json({ call: rows[0] ?? null });
});
contextRouter.get('/calls/:id/context', async (req, res) => {
  const user = await resolveUser(req);
  const call = await queryOne('SELECT id, destination, created_at FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
  if (!call) throw new HttpError(404, 'call_not_found');
  res.json(await contactContext(user.id, call.destination, { before: call.created_at, exclude: call.id }));
});
