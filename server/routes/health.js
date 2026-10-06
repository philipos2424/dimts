import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { runHealthChecks } from '../services/health.js';

export const healthRouter = express.Router();

// An uptime monitor sends `Authorization: Bearer $HEALTH_TOKEN`; Vercel Cron
// sends `Bearer $CRON_SECRET`. The answer names balances and failure counts,
// so it is never public.
function authorized(req) {
  const sent = Buffer.from(req.get('authorization') ?? '');
  return [process.env.HEALTH_TOKEN, process.env.CRON_SECRET].some(secret => {
    if (!secret || secret.length < 16) return false;
    const expected = Buffer.from(`Bearer ${secret}`);
    return expected.length === sent.length && timingSafeEqual(expected, sent);
  });
}

healthRouter.get('/', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const report = await runHealthChecks();
  for (const failed of report.checks.filter(c => !c.ok)) console.error(`[health] ${failed.name}: ${failed.detail ?? 'failed'}`);
  // 503 lets any uptime monitor alert on status alone.
  res.status(report.ok ? 200 : 503).set('Cache-Control', 'no-store').json(report);
});
