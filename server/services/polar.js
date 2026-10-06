import { HttpError } from '../lib/users.js';

/** Polar API client. Sandbox and production are separate accounts with separate tokens. */
const baseUrl = () => (process.env.POLAR_SERVER === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh');

export const billingConfigured = () => Boolean(process.env.POLAR_ACCESS_TOKEN && process.env.POLAR_PRODUCTS && process.env.POLAR_WEBHOOK_SECRET);

async function polar(method, path, body) {
  if (!billingConfigured()) throw new HttpError(503, 'billing_unavailable', 'Payments are not switched on yet.');
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.POLAR_ACCESS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error('[polar] request failed', method, path, err?.message);
    throw new HttpError(502, 'billing_unavailable', 'Payments are unavailable right now. Try again in a minute.');
  }
  if (!res.ok) {
    // Polar's error bodies describe our request, never card data; log them for diagnosis.
    console.error('[polar]', method, path, res.status, (await res.text().catch(() => '')).slice(0, 500));
    throw new HttpError(502, 'billing_unavailable', 'Payments are unavailable right now. Try again in a minute.');
  }
  return res.status === 204 ? null : res.json();
}

/** A hosted checkout for one product, tied to the Dimts user by external customer ID. */
export async function createCheckout({ userId, productId, currency, ip, locale, successUrl, returnUrl }) {
  const checkout = await polar('POST', '/v1/checkouts/', {
    products: [productId],
    external_customer_id: userId,
    metadata: { user_id: userId },
    currency,
    // Polar picks tax and currency from the buyer's location; without this it sees our server.
    ...(ip ? { customer_ip_address: ip } : {}),
    ...(locale ? { locale } : {}),
    success_url: successUrl,
    return_url: returnUrl,
  });
  return { id: checkout.id, url: checkout.url };
}

/** Polar's customer portal: change plan, update card, see invoices, cancel. */
export async function createPortalSession(userId, returnUrl) {
  const session = await polar('POST', '/v1/customer-sessions/', { external_customer_id: userId, return_url: returnUrl });
  return { url: session.customer_portal_url };
}

/** End a subscription immediately, without a refund. Used when an account is deleted. */
export function revokeSubscription(subscriptionId) {
  return polar('DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}
