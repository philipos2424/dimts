import express from 'express';
import { captureCallFailure } from './lib/sentry.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { authRouter } from './routes/auth.js';
import { contactsRouter } from './routes/contacts.js';
import { followupsRouter } from './routes/followups.js';
import { contextRouter } from './routes/context.js';
import { googleRouter, googleBrowserRouter } from './routes/google.js';
import { calendarActionsRouter } from './routes/calendar-actions.js';
import { emailActionsRouter } from './routes/email-actions.js';
import { recordingRecoveryRouter } from './routes/recording-recovery.js';
import { callDeletionRouter, deletionsRouter } from './routes/call-deletion.js';
import { notificationsRouter } from './routes/notifications.js';
import { callsRouter, usageRouter } from './routes/calls.js';
import { appCallsRouter } from './routes/app-calls.js';
import { meRouter } from './routes/me.js';
import { promisesRouter } from './routes/promises.js';
import { recapRouter } from './routes/recap.js';
import { askRouter } from './routes/ask.js';
import { healthRouter } from './routes/health.js';
import { eventsRouter } from './routes/events.js';
import { briefingRouter, cronRouter } from './routes/briefing.js';
import { myPrivacyRequestsRouter, privacyRequestsRouter } from './routes/privacy-requests.js';
import { inboundRouter } from './routes/inbound.js';
import { waitlistRouter } from './routes/waitlist.js';
import { billingRouter, polarWebhookRouter } from './routes/billing.js';
import { adminApiRouter, adminPageRouter } from './routes/admin.js';
import { twimlRouter, webhooksRouter } from './routes/webhooks.js';
import { apiRateLimit } from './lib/rate-limit.js';
import { securityHeaders, WEB_SHELL_CSP } from './lib/security-headers.js';
import { safeError } from './lib/log-safe.js';

export function createApp({ webRoot = fileURLToPath(new URL('../dist/', import.meta.url)) } = {}) {
  const app = express();

  // Twilio signature validation anchors on PUBLIC_BASE_URL rather than the
  // request host, but trusting the proxy keeps req.ip and friends honest.
  app.set('trust proxy', 1);
  app.use(securityHeaders);

  // Telnyx signs the exact request bytes, so keep them alongside the parsed body.
  const keepRawBody = (req, _res, buf) => { req.rawBody = buf; };
  app.use(express.json({ verify: keepRawBody }));
  app.use(express.urlencoded({ extended: false, verify: keepRawBody })); // carriers post form-encoded

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', apiRateLimit);
  app.use('/api/health', healthRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/integrations/google', googleRouter);
  app.use('/oauth/google', googleBrowserRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api', contextRouter);

  app.use('/api/app-calls', appCallsRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/calls', callDeletionRouter);
  app.use('/api/call-deletions', deletionsRouter);
  app.use('/api/calls', recordingRecoveryRouter);
  app.use('/api/calls', calendarActionsRouter);
  app.use('/api/calls', emailActionsRouter);
  app.use('/api/calls', followupsRouter);
  app.use('/api/calls', recapRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/promises', promisesRouter);
  app.use('/api/ask', askRouter);
  app.use('/api/briefing', briefingRouter);
  app.use('/api/cron', cronRouter);
  app.use('/api/me/privacy-requests', myPrivacyRequestsRouter);
  app.use('/api/me', meRouter);
  app.use('/api/privacy-requests', privacyRequestsRouter);
  app.use('/api/waitlist', waitlistRouter);
  app.use('/api/admin', adminApiRouter);
  app.use('/admin', adminPageRouter);
  app.use('/twiml/incoming', inboundRouter);
  app.use('/twiml', twimlRouter);
  app.use('/webhooks/polar', polarWebhookRouter);
  app.use('/webhooks', webhooksRouter);

  if (existsSync(webRoot)) {
    app.use(express.static(webRoot, { extensions: ['html'],
      setHeaders: (res, file) => { if (file.endsWith('.html')) res.set('Content-Security-Policy', WEB_SHELL_CSP); } }));
    // Expo's single-page export needs the app shell on browser refresh/deep
    // links. Whitelist app routes so missing APIs/webhooks/assets stay errors.
    app.get(['/', '/onboarding', '/settings', '/first-call', '/dialer', '/ask', '/calls', '/in-call', '/call/:id', '/person/:id',
      '/privacy', '/terms', '/privacy-request', '/subprocessors', '/terms-accept', '/plans'],
      (req,res,next) => {
        if (!req.accepts('html') || (req.params.id && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.params.id))) return next();
        res.set({ 'Cache-Control': 'no-cache', 'Content-Security-Policy': WEB_SHELL_CSP }).sendFile('index.html',{root:webRoot});
      });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  /**
   * Terminal error handler.
   *
   * Vercel's docs are explicit that an unhandled Express error can leave the
   * function instance in an undefined state, because Express renders its own
   * 500 page and Vercel never learns it should discard the instance. So this
   * is a correctness requirement under Fluid compute, not just tidiness.
   */
  app.use((err, _req, res, _next) => {
    const status = err?.status ?? 500;
    if (status >= 500) captureCallFailure(err, { stage: 'server' });
    if (status >= 500) console.error('[error]', safeError(err));
    if (err?.retryAfter) res.set('Retry-After', String(err.retryAfter));

    res.status(status).json({
      error: err?.code ?? 'internal_error',
      message: status >= 500 ? 'Something went wrong' : err?.message,
    });
  });

  return app;
}
