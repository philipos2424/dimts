import express from 'express';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { claimNumber } from '../db/claim-number.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { TERMS_VERSION, hasAcceptedTerms } from '../lib/terms.js';
import { audit } from '../lib/audit.js';
import { confirmCallerId, startCallerIdVerification } from '../services/caller-id.js';
import { hit } from '../lib/rate-limit.js';
import { buildExport } from '../services/export-user.js';
import { deleteAccount } from '../services/delete-account.js';
import { liveSubscriptionIds } from '../services/billing.js';
import { planOf } from '../lib/pricing.js';
import { revokeSubscription } from '../services/polar.js';
import { RETENTION_MONTHS } from '../services/retention.js';
import { refuseForReviewDemo } from '../lib/review-demo.js';

export const meRouter = express.Router();

meRouter.post('/number', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    refuseForReviewDemo(user);
    if (user.agent_number) return res.json({ agent_number: user.agent_number });
    // Each number costs about $1 a month whether or not it rings, so it comes with a paid plan.
    if (planOf(user) === 'free') throw new HttpError(402, 'plan_required', 'A business number comes with Pro and Business.');
    if (!process.env.PUBLIC_BASE_URL) throw new HttpError(503, 'routing_unavailable', 'Business-number routing is not configured yet.');
    const base = new URL(config.publicBaseUrl);
    if (base.protocol !== 'https:') throw new HttpError(503, 'routing_unavailable');
    res.json(await claimNumber(user.id, `${config.publicBaseUrl}/twiml/incoming`));
  } catch (err) { next(err); }
});

meRouter.post('/caller-id/start', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    refuseForReviewDemo(user);
    await hit(`caller-id:${user.id}`, 5, 3600);
    const { alreadyVerified } = await startCallerIdVerification(user.phone, req.body?.method);
    if (alreadyVerified) {
      await query('UPDATE users SET caller_id_verified_at=now() WHERE id=$1', [user.id]);
      await audit({ userId: user.id, action: 'caller_id_enabled', req });
      return res.json({ status: 'verified' });
    }
    res.status(202).json({ status: 'code_sent' });
  } catch (err) { next(err); }
});

meRouter.post('/caller-id/verify', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    refuseForReviewDemo(user);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!/^\d{4,10}$/.test(code)) throw new HttpError(400, 'invalid_code');
    await hit(`caller-id-check:${user.id}`, 10, 3600);
    if (!(await confirmCallerId(user.phone, code))) throw new HttpError(401, 'invalid_code');
    await query('UPDATE users SET caller_id_verified_at=now() WHERE id=$1', [user.id]);
    await audit({ userId: user.id, action: 'caller_id_enabled', req });
    res.json({ status: 'verified' });
  } catch (err) { next(err); }
});

meRouter.delete('/caller-id', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await query('UPDATE users SET caller_id_verified_at=NULL WHERE id=$1', [user.id]);
    await audit({ userId: user.id, action: 'caller_id_disabled', req });
    res.json({ status: 'off' });
  } catch (err) { next(err); }
});

/** The app needs to know which number to tell the user to publish. */
meRouter.get('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    res.json({
      phone: user.phone,
      tier: user.tier,
      agent_number: user.agent_number ?? null,
      // Set while a Free account keeps its number after a paid plan ended.
      number_release_at: user.agent_number ? (await queryOne('SELECT number_release_at FROM users WHERE id=$1', [user.id]))?.number_release_at ?? null : null,
      terms_required: !hasAcceptedTerms(user),
      language: user.language ?? 'en',
      retention_months: user.retention_months ?? null,
      caller_id: !!user.caller_id_verified_at,
    });
  } catch (err) { next(err); }
});

meRouter.post('/terms', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    if (req.body?.version !== TERMS_VERSION) throw new HttpError(400, 'terms_version_mismatch', 'Reload the app to see the current terms.');
    const row = await queryOne(`UPDATE users SET terms_version=$2,terms_accepted_at=now()
      WHERE id=$1 RETURNING terms_accepted_at`, [user.id, TERMS_VERSION]);
    await audit({ userId: user.id, action: 'terms_accepted', targetType: 'terms', targetId: TERMS_VERSION, req });
    res.json({ accepted_at: row.terms_accepted_at });
  } catch (err) { next(err); }
});

meRouter.get('/activity', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { rows } = await query(`SELECT action,target_type,target_id,created_at FROM audit_events
      WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 200`, [user.id]);
    res.json({ events: rows });
  } catch (err) { next(err); }
});

meRouter.get('/export', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await hit(`export:${user.id}`, 5, 3600);
    const data = await buildExport(user.id);
    await audit({ userId: user.id, action: 'data_exported', req });
    res.set('Content-Disposition', `attachment; filename="dimts-export-${data.exported_at.slice(0, 10)}.json"`).json(data);
  } catch (err) { next(err); }
});

meRouter.delete('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    if (req.body?.confirm !== 'delete-account') throw new HttpError(400, 'deletion_confirmation_required');
    // Stop billing first: a deleted account must never be charged again. If
    // Polar is unreachable the deletion waits rather than leaving a live plan.
    for (const id of await liveSubscriptionIds(user.id)) await revokeSubscription(id);
    const result = await deleteAccount(user.id);
    await audit({ userId: user.id, action: 'account_deleted', req });
    res.status(202).json(result);
  } catch (err) { next(err); }
});

meRouter.patch('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const body = req.body ?? {};
    const setLanguage = 'language' in body, setRetention = 'retention_months' in body;
    if (setLanguage && !['en', 'am'].includes(body.language)) throw new HttpError(400, 'invalid_language');
    if (setRetention && body.retention_months !== null && !RETENTION_MONTHS.includes(body.retention_months)) throw new HttpError(400, 'invalid_retention');
    if (!setLanguage && !setRetention) throw new HttpError(400, 'nothing_to_change');
    const row = await queryOne(`UPDATE users SET language=CASE WHEN $2 THEN $3 ELSE language END,
      retention_months=CASE WHEN $4 THEN $5::int ELSE retention_months END WHERE id=$1 RETURNING language,retention_months`,
    [user.id, setLanguage, setLanguage ? body.language : null, setRetention, setRetention ? body.retention_months : null]);
    if (setRetention) await audit({ userId: user.id, action: 'retention_changed', targetType: 'retention', targetId: body.retention_months ?? 'off', req });
    res.json(row);
  } catch (err) { next(err); }
});

// Signed-in devices. A stolen phone number signs in with a valid code, so the
// owner must be able to see every session and end it.
meRouter.get('/sessions', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { rows } = await query(`SELECT id, device_name, created_at, last_seen_at FROM sessions
      WHERE user_id=$1 AND expires_at > now() ORDER BY coalesce(last_seen_at, created_at) DESC LIMIT 50`, [user.id]);
    res.set('Cache-Control', 'no-store').json({ sessions: rows.map(row => ({ ...row, current: row.id === user.sessionId })) });
  } catch (err) { next(err); }
});

meRouter.delete('/sessions/:id', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) throw new HttpError(404, 'session_not_found');
    const ended = await queryOne('DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, user.id]);
    if (!ended) throw new HttpError(404, 'session_not_found');
    await audit({ userId: user.id, action: 'session_revoked', targetType: 'session', targetId: ended.id, req });
    res.json({ status: 'signed_out', current: ended.id === user.sessionId });
  } catch (err) { next(err); }
});

/** Ends every other session; with ?all=1, this one too. */
meRouter.post('/sessions/revoke', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const all = req.query.all === '1';
    const { rows } = await query(`DELETE FROM sessions WHERE user_id=$1 AND ($2::boolean OR id<>$3) RETURNING id`,
      [user.id, all, user.sessionId]);
    await audit({ userId: user.id, action: all ? 'sessions_revoked_all' : 'sessions_revoked_others', req });
    res.json({ status: 'signed_out', ended: rows.length });
  } catch (err) { next(err); }
});
