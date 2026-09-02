import express from 'express';
import { callsRouter, usageRouter } from './routes/calls.js';
import { twimlRouter, webhooksRouter } from './routes/webhooks.js';

export function createApp() {
  const app = express();

  // Twilio signature validation anchors on PUBLIC_BASE_URL rather than the
  // request host, but trusting the proxy keeps req.ip and friends honest.
  app.set('trust proxy', true);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/calls', callsRouter);
  app.use('/api/usage', usageRouter);
  app.use('/twiml', twimlRouter);
  app.use('/webhooks', webhooksRouter);

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
