import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { resolveUser } from '../lib/users.js';
import { query } from '../db/pool.js';
import { weeklyBriefing, briefingIsEmpty } from '../services/briefing.js';
import { sendBriefingNotification } from '../services/briefing-push.js';
import { expireOldCalls } from '../services/retention.js';
import { releaseExpiredNumbers } from '../services/release-numbers.js';
import { syncProviderCosts } from '../services/provider-costs.js';
import { encryptExisting } from '../services/encrypt-existing.js';
import { encryptionEnabled } from '../lib/field-crypto.js';

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

// Daily housekeeping: delete calls past each owner's retention period,
// release business numbers whose grace has ended, copy carrier costs, and
// encrypt a batch of anything stored before encryption at rest (or under an
// old key) until nothing is left.
// One cron path, because plans with few cron slots must still run all three.
cronRouter.get('/retention', async (req, res) => {
  if (!authorizedCron(req)) return res.status(401).json({ error: 'unauthorized' });
  const result = await expireOldCalls();
  const numbers = await releaseExpiredNumbers().catch(err => ({ error: err?.message }));
  const costs = await syncProviderCosts().catch(err => ({ error: err?.message }));
  // Recordings are copied one by one, so keep that batch small enough for one run.
  const encryption = encryptionEnabled()
    ? await encryptExisting({ limit: 200, audioLimit: 20 }).catch(err => ({ error: err?.message }))
    : { skipped: 'encryption_off' };
  res.json({ ...result, numbers, costs, encryption });
});
