import express from 'express';
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
import { callsRouter, meRouter, usageRouter } from './routes/calls.js';
import { inboundRouter } from './routes/inbound.js';
import { twimlRouter, webhooksRouter } from './routes/webhooks.js';

export function createApp() {
  const app = express();

  // Twilio signature validation anchors on PUBLIC_BASE_URL rather than the
  // request host, but trusting the proxy keeps req.ip and friends honest.
  app.set('trust proxy', 1);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/auth', authRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/integrations/google', googleRouter);
  app.use('/oauth/google', googleBrowserRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api', contextRouter);

  app.use('/api/calls', callsRouter);
  app.use('/api/calls', callDeletionRouter);
  app.use('/api/call-deletions', deletionsRouter);
  app.use('/api/calls', recordingRecoveryRouter);
  app.use('/api/calls', calendarActionsRouter);
  app.use('/api/calls', emailActionsRouter);
  app.use('/api/calls', followupsRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/me', meRouter);
  app.use('/twiml/incoming', inboundRouter);
  app.use('/twiml', twimlRouter);
  app.use('/webhooks', webhooksRouter);

  const webRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  if (existsSync(webRoot)) app.use(express.static(webRoot, { extensions: ['html'] }));

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
    if (status >= 500) console.error('[error]', err);

    res.status(status).json({
      error: err?.code ?? 'internal_error',
      message: status >= 500 ? 'Something went wrong' : err?.message,
    });
  });

  return app;
}
