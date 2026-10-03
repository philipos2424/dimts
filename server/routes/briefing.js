import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { resolveUser } from '../lib/users.js';
import { query } from '../db/pool.js';
import { weeklyBriefing, briefingIsEmpty } from '../services/briefing.js';
import { sendBriefingNotification } from '../services/briefing-push.js';

export const briefingRouter = express.Router();

briefingRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  res.set('Cache-Control', 'private, no-store').json(await weeklyBriefing(user.id));
});

export const cronRouter = express.Router();

// Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET` every Monday.
function authorizedCron(req) {
  const secret = process.env.CRON_SECRET, sent = req.get('authorization') ?? '';
  if (!secret || secret.length < 16) return false;
  const expected = Buffer.from(`Bearer ${secret}`), given = Buffer.from(sent);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

cronRouter.get('/weekly-briefing', async (req, res) => {
  if (!authorizedCron(req)) return res.status(401).json({ error: 'unauthorized' });
  // Only owners who can receive a push; one briefing each, best effort.
  const { rows } = await query(`SELECT DISTINCT u.id, u.language FROM users u
    JOIN notification_devices d ON d.user_id=u.id AND NOT d.disabled
    JOIN sessions s ON s.token_hash=d.session_hash AND s.expires_at>now()
    WHERE u.deleted_at IS NULL`);
  let sent = 0;
  for (const user of rows) {
    try {
      const briefing = await weeklyBriefing(user.id);
      if (briefingIsEmpty(briefing)) continue;
      if (await sendBriefingNotification(user.id, briefing, user.language)) sent++;
    } catch (err) { console.error('[briefing] failed for a user', err?.message); }
  }
  res.json({ users: rows.length, sent });
});
