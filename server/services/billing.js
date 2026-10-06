import * as database from '../db/pool.js';
import { CREDIT_PACKS, PLANS, planOf } from '../lib/pricing.js';
import { parsePlanKey, productKeyFor } from '../lib/polar-products.js';
import { PLAN_SECONDS_SQL } from '../db/plan-usage.js';
import { claimNumber, incomingVoiceUrl } from '../db/claim-number.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// past_due keeps the plan while Polar retries the card; it ends in canceled or active.
const GRANTING = ['active', 'trialing', 'past_due'];

function ownerOf(data) {
  const id = data?.customer?.external_id ?? data?.metadata?.user_id;
  return UUID.test(id ?? '') ? id : null;
}

/** The plan a user holds is the best plan among their live subscriptions. */
export async function syncTier(tx, userId) {
  const { rows } = await tx.query('SELECT plan FROM subscriptions WHERE user_id=$1 AND status = ANY($2)', [userId, GRANTING]);
  const plans = rows.map(row => row.plan);
  const tier = plans.includes('business') ? 'business' : plans.includes('pro') ? 'pro' : 'free';
  // Dropping to Free keeps the business number for 30 days, so callers who
  // already have it are not cut off while the owner decides; paying again cancels that.
  await tx.query(`UPDATE users SET tier=$2,
    number_release_at = CASE WHEN $2 <> 'free' OR agent_number IS NULL THEN NULL
      ELSE COALESCE(number_release_at, now() + interval '30 days') END
    WHERE id=$1`, [userId, tier]);
  return tier;
}

async function applySubscription(tx, data, userId) {
  const key = productKeyFor(data.product_id ?? data.product?.id);
  const plan = parsePlanKey(key);
  if (!plan) return 'ignored_product';
  // Deliveries can arrive out of order; an older snapshot never overwrites a newer one.
  await tx.query(`INSERT INTO subscriptions(id,user_id,product_key,plan,billing_interval,status,current_period_end,cancel_at_period_end,provider_modified_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(id) DO UPDATE SET product_key=EXCLUDED.product_key, plan=EXCLUDED.plan, billing_interval=EXCLUDED.billing_interval,
      status=EXCLUDED.status, current_period_end=EXCLUDED.current_period_end, cancel_at_period_end=EXCLUDED.cancel_at_period_end,
      provider_modified_at=EXCLUDED.provider_modified_at, updated_at=now()
    WHERE subscriptions.provider_modified_at IS NULL OR EXCLUDED.provider_modified_at IS NULL
      OR EXCLUDED.provider_modified_at >= subscriptions.provider_modified_at`,
    [data.id, userId, key, plan.plan, plan.interval, String(data.status ?? 'unknown'),
      data.current_period_end ?? null, Boolean(data.cancel_at_period_end), data.modified_at ?? data.created_at ?? null]);
  await syncTier(tx, userId);
  return 'applied';
}

async function applyOrder(tx, type, data, userId) {
  const key = productKeyFor(data.product_id ?? data.product?.id);
  if (!key) return 'ignored_product';
  // Revenue record for unit economics: every paid order, plans and credits alike.
  const amount = value => (Number.isSafeInteger(Number(value)) ? Number(value) : 0);
  await tx.query(`INSERT INTO payments(order_id,user_id,product_key,currency,total_amount,tax_amount,refunded_amount,paid_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()))
    ON CONFLICT(order_id) DO UPDATE SET refunded_amount=GREATEST(payments.refunded_amount, EXCLUDED.refunded_amount)`,
    [data.id, userId, key, String(data.currency ?? 'usd').toLowerCase(), amount(data.total_amount), amount(data.tax_amount),
      amount(data.refunded_amount), data.created_at ?? null]);
  const pack = CREDIT_PACKS[key];
  if (!pack) return 'applied'; // Plan access follows subscription events.
  if (type === 'order.paid') {
    await tx.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key) VALUES($1,$2,'purchase',$3)
      ON CONFLICT(source_key) DO NOTHING`, [userId, pack.credits, `order:${data.id}`]);
    return 'applied';
  }
  // Refunds take back credits in proportion; one row per order tracks the running total.
  const total = Number(data.total_amount), refunded = Number(data.refunded_amount);
  if (!(total > 0) || !(refunded > 0)) return 'ignored_amount';
  const credits = Math.min(pack.credits, Math.round(pack.credits * refunded / total));
  await tx.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,source_key) VALUES($1,$2,'refund',$3)
    ON CONFLICT(source_key) DO UPDATE SET amount_cents=LEAST(credit_ledger.amount_cents, EXCLUDED.amount_cents)`,
    [userId, -credits, `refund:${data.id}`]);
  return 'applied';
}

/**
 * Apply one verified Polar webhook exactly once. The delivery ID is recorded
 * in the same transaction as its effect, so a retry after a crash either
 * finds nothing done or everything done.
 */
export function applyPolarEvent(webhookId, event) {
  return database.withTransaction(async tx => {
    const fresh = await tx.query('INSERT INTO billing_events(webhook_id,type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING webhook_id',
      [webhookId, String(event?.type ?? 'unknown').slice(0, 80)]);
    if (!fresh.rows.length) return 'duplicate';
    const type = event?.type ?? '';
    const handled = type.startsWith('subscription.') || ['order.paid', 'order.refunded'].includes(type);
    if (!handled) return 'ignored_type';
    const userId = ownerOf(event.data);
    const user = userId && (await tx.query('SELECT id FROM users WHERE id=$1', [userId])).rows[0];
    if (!user) {
      console.error('[billing] event for unknown customer', type, event?.data?.id);
      return 'unknown_customer';
    }
    return type.startsWith('subscription.') ? applySubscription(tx, event.data, user.id) : applyOrder(tx, type, event.data, user.id);
  });
}

/**
 * A paid plan includes a business number, so hand it over as soon as the
 * subscription lands rather than waiting for the owner to find the button.
 * Runs after the webhook is acknowledged; if it fails, the button still works.
 */
export async function assignNumberAfterUpgrade(event, db = database, claim = claimNumber) {
  if (!String(event?.type ?? '').startsWith('subscription.')) return null;
  const userId = ownerOf(event.data);
  const voiceUrl = incomingVoiceUrl();
  if (!userId || !voiceUrl) return null;
  const user = await db.queryOne('SELECT id, tier, agent_number FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
  if (!user || planOf(user) === 'free' || user.agent_number) return null;
  return claim(user.id, voiceUrl);
}

/** Plan, minutes and credits as the app shows them. */
export async function billingState(user, db = database) {
  const tier = planOf(user);
  const [usage, credits, subscription, number] = await Promise.all([
    db.queryOne(`SELECT COALESCE(sum(${PLAN_SECONDS_SQL}),0)::int AS seconds FROM calls
      WHERE user_id=$1 AND NOT budget_released
      AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [user.id]),
    db.queryOne('SELECT COALESCE(sum(amount_cents),0)::int AS cents FROM credit_ledger WHERE user_id=$1', [user.id]),
    db.queryOne(`SELECT plan,billing_interval,status,current_period_end,cancel_at_period_end FROM subscriptions
      WHERE user_id=$1 AND status = ANY($2) ORDER BY (plan='business') DESC, updated_at DESC LIMIT 1`, [user.id, GRANTING]),
    db.queryOne('SELECT agent_number, number_release_at FROM users WHERE id=$1', [user.id]),
  ]);
  return {
    tier,
    minutes_included: PLANS[tier].minutes,
    minutes_used: Math.round(usage.seconds / 6) / 10,
    credits_cents: credits.cents,
    business_number: number?.agent_number ?? null,
    number_release_at: number?.agent_number ? number.number_release_at : null,
    subscription: subscription ? {
      plan: subscription.plan,
      interval: subscription.billing_interval,
      status: subscription.status,
      renews_at: subscription.cancel_at_period_end ? null : subscription.current_period_end,
      ends_at: subscription.cancel_at_period_end ? subscription.current_period_end : null,
    } : null,
  };
}

/** Subscriptions to end when an account is deleted. */
export async function liveSubscriptionIds(userId, db = database) {
  const { rows } = await db.query('SELECT id FROM subscriptions WHERE user_id=$1 AND status = ANY($2)', [userId, GRANTING]);
  return rows.map(row => row.id);
}
