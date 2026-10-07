import express from 'express';
import { fileURLToPath } from 'node:url';
import { ACCESS_REASONS, requireAdmin } from '../lib/admin.js';
import { audit } from '../lib/audit.js';
import { hit } from '../lib/rate-limit.js';
import { HttpError } from '../lib/users.js';
import {
  accessLog, cohorts, compliance, customerDetail, customerPhone, customers, grantCredits, overview,
} from '../services/admin-metrics.js';

/**
 * Operator console API. Every request is from an allowlisted, recently
 * signed-in staff member (lib/admin.js) and is written to the audit log, so
 * staff access to customer data is itself on the record. Reading one
 * customer's details also shows in that customer's own activity log.
 */
export const adminApiRouter = express.Router();

const handler = (section, work) => async (req, res, next) => {
  try {
    const staff = await requireAdmin(req);
    await hit(`admin:${staff.id}`, 600, 3600);
    const body = await work(req, staff);
    await audit({ userId: staff.id, action: `admin_${section}`, targetType: req.params.id ? 'user' : null, targetId: req.params.id, req });
    res.json(body);
  } catch (err) { next(err); }
};

adminApiRouter.get('/me', handler('signed_in', async (_req, staff) => ({ reasons: ACCESS_REASONS, staff_id: staff.id })));
adminApiRouter.get('/overview', handler('viewed_overview', () => overview()));
adminApiRouter.get('/cohorts', handler('viewed_cohorts', async () => ({ cohorts: await cohorts() })));
adminApiRouter.get('/compliance', handler('viewed_compliance', () => compliance()));
adminApiRouter.get('/customers', handler('searched_customers', req => customers({
  q: String(req.query.q ?? '').slice(0, 64), plan: String(req.query.plan ?? ''), page: req.query.page,
})));
adminApiRouter.get('/access-log', handler('viewed_access_log', () => accessLog()));

function reasonOf(req) {
  const reason = req.body?.reason ?? req.query?.reason;
  if (!ACCESS_REASONS.includes(reason)) throw new HttpError(400, 'reason_required', `Say why: one of ${ACCESS_REASONS.join(', ')}.`);
  return reason;
}

// Opening one person's account needs a reason, and they can see that it happened.
adminApiRouter.get('/customers/:id', async (req, res, next) => {
  try {
    const staff = await requireAdmin(req);
    const reason = reasonOf(req);
    const detail = await customerDetail(req.params.id);
    await audit({ userId: staff.id, action: 'admin_viewed_customer', targetType: 'user', targetId: detail.id, reason, req });
    await audit({ userId: detail.id, action: 'staff_viewed_account', targetType: 'staff', reason });
    res.json(detail);
  } catch (err) { next(err); }
});

adminApiRouter.post('/customers/:id/reveal-phone', async (req, res, next) => {
  try {
    const staff = await requireAdmin(req);
    const reason = reasonOf(req);
    await hit(`admin-reveal:${staff.id}`, 30, 3600);
    const phone = await customerPhone(req.params.id);
    await audit({ userId: staff.id, action: 'admin_revealed_phone', targetType: 'user', targetId: req.params.id, reason, req });
    await audit({ userId: req.params.id, action: 'staff_viewed_phone', targetType: 'staff', reason });
    res.json({ phone });
  } catch (err) { next(err); }
});

adminApiRouter.post('/customers/:id/credits', async (req, res, next) => {
  try {
    const staff = await requireAdmin(req);
    const reason = reasonOf(req);
    await hit(`admin-grant:${staff.id}`, 20, 86400);
    const result = await grantCredits(req.params.id, req.body?.credits);
    await audit({ userId: staff.id, action: 'admin_granted_credits', targetType: 'user', targetId: req.params.id, reason, req });
    await audit({ userId: req.params.id, action: 'credits_granted', targetType: 'credits', targetId: req.body.credits });
    res.json(result);
  } catch (err) { next(err); }
});

// The console page itself is static and holds no data; it calls the API above.
const pageRoot = fileURLToPath(new URL('../admin/', import.meta.url));
export const ADMIN_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

export const adminPageRouter = express.Router();
adminPageRouter.use((_req, res, next) => {
  res.set({ 'Content-Security-Policy': ADMIN_CSP, 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  next();
});
adminPageRouter.get('/', (req, res, next) => {
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(308, '/admin/');
  res.sendFile('index.html', { root: pageRoot }, err => err && next(err));
});
adminPageRouter.get(['/admin.js', '/admin.css'], (req, res, next) => {
  res.sendFile(req.path.slice(1), { root: pageRoot }, err => err && next(err));
});
