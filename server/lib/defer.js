import { isServerless } from '../config.js';
const pending = new Set();

/** Called only after HTTP intake is closed; include jobs spawned by other jobs. */
export async function drainDeferredWork() {
  while (pending.size) await Promise.all([...pending]);
}

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
 * tracked promise lets production shutdown wait for work already started.
 */
export function defer(promise, label = 'task') {
  const guarded = Promise.resolve(promise).catch(() => {
    // Provider exceptions can contain request headers or private call content.
    console.error(`[defer:${label}] Background task failed; inspect its saved state.`);
  });
  pending.add(guarded);
  guarded.then(() => pending.delete(guarded));

  if (isServerless) {
    import('@vercel/functions')
      .then(({ waitUntil }) => waitUntil(guarded))
      .catch(() => console.error('[defer] waitUntil unavailable'));
  }

  return guarded;
}
