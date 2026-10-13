import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import * as database from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { verifyWebhook } from '../lib/standard-webhooks.js';
import { refuseForReviewDemo } from '../lib/review-demo.js';
import { audit } from '../lib/audit.js';
import { minimeBotUsername, minimeConfigured, minimePost } from '../services/minime.js';

const hashToken = token => createHash('sha256').update(token).digest('hex');
const { query, queryOne } = database;

/** The signed-in owner's link to MiniMe: status, connect, auto-send switch, disconnect. */
export const minimeRouter = express.Router();

minimeRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  const link = await queryOne('SELECT business_name, auto_send, linked_at FROM minime_links WHERE user_id=$1', [user.id]);
  res.json({ available: minimeConfigured(), linked: !!link, reviewed_file_actions: process.env.MINIME_FILE_ACTIONS === '1', ...(link ?? {}) });
});

/** Opens Telegram on MiniMe's bot with a one-time token; MiniMe confirms it back to us. */
minimeRouter.post('/link', async (req, res) => {
  const user = await resolveUser(req);
  refuseForReviewDemo(user);
  if (!minimeConfigured()) throw new HttpError(503, 'minime_unavailable', 'MiniMe is not available yet.');
  const token = randomBytes(24).toString('base64url');
  await query('DELETE FROM minime_link_tokens WHERE user_id=$1 OR expires_at < now()', [user.id]);
  await query('INSERT INTO minime_link_tokens(token_hash,user_id) VALUES($1,$2)', [hashToken(token), user.id]);
  res.json({ url: `https://t.me/${minimeBotUsername()}?start=dimts_${token}` });
});

minimeRouter.patch('/', async (req, res) => {
  const user = await resolveUser(req);
  if (typeof req.body?.auto_send !== 'boolean') throw new HttpError(400, 'invalid_auto_send');
  const link = await queryOne('UPDATE minime_links SET auto_send=$2 WHERE user_id=$1 RETURNING business_name, auto_send, linked_at',
    [user.id, req.body.auto_send]);
  if (!link) throw new HttpError(404, 'minime_not_linked');
  res.json({ available: minimeConfigured(), linked: true, reviewed_file_actions: process.env.MINIME_FILE_ACTIONS === '1', ...link });
});

minimeRouter.delete('/', async (req, res) => {
  const user = await resolveUser(req);
  const removed = await database.withTransaction(async tx => {
    await tx.query('SELECT user_id FROM minime_links WHERE user_id=$1 FOR UPDATE', [user.id]);
    const { rows: pending } = await tx.query("SELECT id FROM file_actions WHERE user_id=$1 AND status IN ('sending','unknown')", [user.id]);
    if (pending.length) throw new HttpError(409, 'file_action_unresolved', 'Check the file sending status before disconnecting MiniMe.');
    return (await tx.query('DELETE FROM minime_links WHERE user_id=$1 RETURNING business_id', [user.id])).rows[0];
  });
  if (removed) {
    await audit({ userId: user.id, action: 'minime_unlinked', req });
    // MiniMe forgets the link too; ours is already gone, so a failure here only leaves a dead row there.
    await minimePost({ type: 'unlink', user_id: user.id }).catch(() => {});
  }
  res.json({ available: minimeConfigured(), linked: false, reviewed_file_actions: process.env.MINIME_FILE_ACTIONS === '1' });
});

/** MiniMe -> Dimts, signed with MINIME_LINK_SECRET. */
export const minimeWebhookRouter = express.Router();

minimeWebhookRouter.use((req, _res, next) => {
  try {
    verifyWebhook({ body: req.rawBody, id: req.get('webhook-id'), timestamp: req.get('webhook-timestamp'),
      signature: req.get('webhook-signature') }, process.env.MINIME_LINK_SECRET);
    next();
  } catch {
    next(new HttpError(401, 'invalid_signature'));
  }
});

/** The owner tapped Start on MiniMe's bot with our token: consume it and link. */
minimeWebhookRouter.post('/link/confirm', async (req, res) => {
  const { token, business_id: businessId, business_name: businessName } = req.body ?? {};
  if (typeof token !== 'string' || !token || token.length > 100 || typeof businessId !== 'string' || !businessId ||
      businessId.length > 100 || (businessName != null && (typeof businessName !== 'string' || businessName.length > 200))) {
    throw new HttpError(400, 'invalid_request');
  }
  const claimed = await queryOne('DELETE FROM minime_link_tokens WHERE token_hash=$1 RETURNING user_id, expires_at > now() AS fresh',
    [hashToken(token)]);
  if (!claimed?.fresh) throw new HttpError(410, 'link_expired');
  await query(`INSERT INTO minime_links(user_id,business_id,business_name) VALUES($1,$2,$3)
    ON CONFLICT (user_id) DO UPDATE SET business_id=EXCLUDED.business_id, business_name=EXCLUDED.business_name, linked_at=now()`,
  [claimed.user_id, businessId, businessName ?? null]);
  await audit({ userId: claimed.user_id, action: 'minime_linked' });
  res.json({ user_id: claimed.user_id });
});

/** A message that was waiting for the caller to reach the bot has now gone (or failed). */
minimeWebhookRouter.post('/deliveries', async (req, res) => {
  const { send_id: sendId, status } = req.body ?? {};
  if (typeof sendId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sendId) || !['sent', 'failed'].includes(status)) {
    throw new HttpError(400, 'invalid_request');
  }
  await query(`UPDATE telegram_sends SET status=$2, error=NULL, updated_at=now() WHERE id=$1 AND status='waiting'`, [sendId, status]);
  res.json({ ok: true });
});
