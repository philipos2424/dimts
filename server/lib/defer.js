import { isServerless } from '../config.js';

/**
 * Run work that must outlive the HTTP response.
 *
 * Twilio hangs up on webhooks that take more than ~15s, but transcribing and
 * summarizing a call takes far longer. So handlers ACK immediately and hand
 * the pipeline here.
 *
 * On Vercel a plain floating promise would be killed the moment the response
 * is sent; `waitUntil` keeps the invocation alive instead, sharing the
 * function's 300s maxDuration. Locally the process is long-lived, so a
 * floating promise is already correct.
 */
export function defer(promise, label = 'task') {
  const guarded = Promise.resolve(promise).catch((err) => {
    console.error(`[defer:${label}]`, err);
  });

  if (isServerless) {
    import('@vercel/functions')
      .then(({ waitUntil }) => waitUntil(guarded))
      .catch((err) => console.error('[defer] waitUntil unavailable', err));
  }

  return guarded;
}
