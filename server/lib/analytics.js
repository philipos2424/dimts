/**
 * Product analytics: the funnel from sign-up to paid, sent to PostHog (EU)
 * from the server. Events carry the account's random ID and coarse facts
 * (plan, country code, direction) only: never a phone number, name, or any
 * call content. With POSTHOG_KEY unset this does nothing.
 */
export const EVENTS = new Set([
  'signed_up', 'call_started', 'first_call', 'notes_ready', 'ask_used', 'recap_shared',
  'paywall_viewed', 'checkout_started', 'subscribed', 'credits_bought', 'trial_started',
  'demo_call_started',
]);

/** Events the app itself may report; everything else is recorded where it happens. */
export const CLIENT_EVENTS = new Set(['paywall_viewed', 'recap_shared']);

export function capture(userId, event, properties = {}) {
  const key = process.env.POSTHOG_KEY;
  if (!key || !userId || !EVENTS.has(event)) return Promise.resolve(false);
  const host = (process.env.POSTHOG_HOST || 'https://eu.i.posthog.com').replace(/\/+$/, '');
  const clean = Object.fromEntries(Object.entries(properties)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 64));
  return fetch(`${host}/capture/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ api_key: key, event, distinct_id: String(userId),
      properties: { ...clean, $process_person_profile: false } }),
  }).then(r => r.ok).catch(() => false);
}
