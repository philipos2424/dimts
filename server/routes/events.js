import express from 'express';
import { resolveUser, HttpError } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';
import { CLIENT_EVENTS, capture } from '../lib/analytics.js';

export const eventsRouter = express.Router();

// The app reports only what the server cannot see (opening Plans, sharing a
// recap). Names are allowlisted and nothing else in the body is recorded.
eventsRouter.post('/', async (req, res) => {
  const user = await resolveUser(req);
  const event = req.body?.event;
  if (!CLIENT_EVENTS.has(event)) throw new HttpError(400, 'invalid_event');
  await hit(`events:${user.id}`, 60, 3600);
  capture(user.id, event);
  res.status(202).json({ ok: true });
});
