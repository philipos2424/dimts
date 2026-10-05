import express from 'express';
import { config } from '../config.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { audit } from '../lib/audit.js';
import { hit } from '../lib/rate-limit.js';
import { canCall } from '../lib/destinations.js';
import { normalizePhone } from '../lib/phone.js';
import { CREDIT_PACKS, INTERVALS, PAID_PLANS, OVERAGE_CENTS_PER_MIN, affordableSeconds, callSurcharge,
  catalogFor, displayCurrency, pick, planProductKey, priceRegion, PLAN_PRICES } from '../lib/pricing.js';
import { polarProducts } from '../lib/polar-products.js';
import { verifyWebhook } from '../lib/standard-webhooks.js';
import { applyPolarEvent, assignNumberAfterUpgrade, billingState } from '../services/billing.js';
import { defer } from '../lib/defer.js';
import { billingConfigured, createCheckout, createPortalSession } from '../services/polar.js';

export const billingRouter = express.Router();

/** Current plan, minutes, credits, and what this user can buy at which price. */
billingRouter.get('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    res.json({ ...(await billingState(user)), catalog: catalogFor(user.phone), purchasable: billingConfigured() });
  } catch (err) { next(err); }
});

/** What a call to this number costs, shown in the dialer before it connects. */
billingRouter.get('/quote', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const to = normalizePhone(String(req.query.to ?? ''));
    if (!to) throw new HttpError(400, 'invalid_destination');
    if (!canCall(to)) throw new HttpError(403, 'destination_not_supported', 'Dimts cannot call numbers in this country or premium-rate numbers.');
    const state = await billingState(user);
    const planSecondsLeft = Math.max(0, Math.floor((state.minutes_included - state.minutes_used) * 60));
    const surcharge = callSurcharge(user.phone, to);
    res.json({
      to,
      surcharge_cents_per_min: surcharge,
      overage_cents_per_min: OVERAGE_CENTS_PER_MIN,
      plan_minutes_left: Math.floor(planSecondsLeft / 60),
      credits_cents: state.credits_cents,
      // plan: covered by plan minutes; credits: some or all of it is paid from credits.
      pays_with: surcharge === 0 && planSecondsLeft >= 60 ? 'plan' : 'credits',
      max_minutes: Math.floor(affordableSeconds({ planSecondsLeft, credits: state.credits_cents, surcharge }) / 60),
    });
  } catch (err) { next(err); }
});

function returnUrls() {
  const base = config.publicBaseUrl;
  return { successUrl: `${base}/plans?checkout=done`, returnUrl: `${base}/plans` };
}

/** Start a Polar checkout for a plan or a credit pack. Plan changes go through the portal. */
billingRouter.post('/checkout', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await hit(`checkout:${user.id}`, 20, 3600);
    const { item, interval = 'month' } = req.body ?? {};
    const region = priceRegion(user.phone);
    const currency = displayCurrency(user.phone);
    let key, price;
    if (PAID_PLANS.includes(item)) {
      if (!INTERVALS.includes(interval)) throw new HttpError(400, 'invalid_interval');
      const state = await billingState(user);
      if (state.subscription) {
        // Polar's portal prorates upgrades and downgrades; a second checkout would double-bill.
        const portal = await createPortalSession(user.id, returnUrls().returnUrl);
        return res.json({ kind: 'portal', url: portal.url });
      }
      key = planProductKey(item, interval, region);
      price = pick(PLAN_PRICES[region][item][interval], currency);
    } else if (CREDIT_PACKS[item]) {
      key = item;
      price = pick(CREDIT_PACKS[item].prices, currency);
    } else throw new HttpError(400, 'invalid_item');
    if (!billingConfigured()) throw new HttpError(503, 'billing_unavailable', 'Payments are not switched on yet.');
    const checkout = await createCheckout({ userId: user.id, productId: polarProducts()[key], currency: price.currency,
      ip: req.ip, ...returnUrls() });
    await audit({ userId: user.id, action: 'checkout_started', targetType: 'product', targetId: key, req });
    res.json({ kind: 'checkout', url: checkout.url });
  } catch (err) { next(err); }
});

/** Manage the plan: change, cancel, update the card, download invoices. */
billingRouter.post('/portal', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await hit(`portal:${user.id}`, 20, 3600);
    res.json(await createPortalSession(user.id, returnUrls().returnUrl));
  } catch (err) { next(err); }
});

export const polarWebhookRouter = express.Router();

polarWebhookRouter.post('/', async (req, res, next) => {
  try {
    try {
      verifyWebhook({ body: req.rawBody, id: req.get('webhook-id'), timestamp: req.get('webhook-timestamp'),
        signature: req.get('webhook-signature') }, process.env.POLAR_WEBHOOK_SECRET);
    } catch {
      return res.status(403).json({ error: 'invalid_signature' });
    }
    const outcome = await applyPolarEvent(req.get('webhook-id'), req.body);
    if (outcome === 'applied') defer(assignNumberAfterUpgrade(req.body), 'assign-number');
    res.status(202).json({ outcome });
  } catch (err) { next(err); }
});
