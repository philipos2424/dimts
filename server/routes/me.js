import express from 'express';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { claimNumber } from '../db/claim-number.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { TERMS_VERSION, hasAcceptedTerms } from '../lib/terms.js';
import { audit } from '../lib/audit.js';
import { hit } from '../lib/rate-limit.js';
import { buildExport } from '../services/export-user.js';
import { deleteAccount } from '../services/delete-account.js';
import { RETENTION_MONTHS } from '../services/retention.js';

export const meRouter = express.Router();

meRouter.post('/number', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    if (user.agent_number) return res.json({ agent_number: user.agent_number });
    if (!process.env.PUBLIC_BASE_URL) throw new HttpError(503, 'routing_unavailable', 'Business-number routing is not configured yet.');
    const base = new URL(config.publicBaseUrl);
    if (base.protocol !== 'https:') throw new HttpError(503, 'routing_unavailable');
    res.json(await claimNumber(user.id, `${config.publicBaseUrl}/twiml/incoming`));
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
      terms_required: !hasAcceptedTerms(user),
      language: user.language ?? 'en',
      retention_months: user.retention_months ?? null,
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
