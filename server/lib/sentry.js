import * as Sentry from '@sentry/node';
import { beforeSend, isEuDsn, safeMessage } from './sentry-privacy.cjs';
import { maskPhones } from './log-safe.js';
import { defer } from './defer.js';

// EU residency is selected by the project DSN, not a separate SDK region flag.
// Reject other destinations even on Vercel (which doesn't run production.js).
const dsn = process.env.SENTRY_DSN;
const enabled = !!dsn && isEuDsn(dsn);
if (dsn && !enabled) console.error('[sentry] Set SENTRY_DSN to a Sentry EU project DSN');
if (enabled) Sentry.init({
  dsn,
  sendDefaultPii: false,
  defaultIntegrations: false,
  integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
  beforeSend,
  beforeBreadcrumb: () => null,
  maxBreadcrumbs: 0,
  tracesSampleRate: 0,
  sendClientReports: false,
  enableLogs: false,
});

export { beforeSend };

export function captureCallFailure(error, { callId, userId, stage = 'processing' } = {}) {
  if (!enabled) return;
  try {
    // Never give the SDK the original error/cause, response, SQL detail or stack.
    const clean = new Error(safeMessage(maskPhones(error?.message ?? '')));
    clean.name = error?.name;
    Sentry.captureException(clean, {
      tags: { stage, carrier: process.env.CARRIER === 'telnyx' ? 'telnyx' : 'twilio', call_id: callId },
      user: userId ? { id: userId } : undefined,
    });
    // Vercel must keep the invocation alive until the event has been delivered.
    defer(Sentry.flush(2000), 'sentry');
  } catch { /* Monitoring must never change the call's outcome. */ }
}
