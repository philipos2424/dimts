import * as database from '../db/pool.js';
import { CREDIT_PACKS, PLANS, planOf } from '../lib/pricing.js';
import { parsePlanKey, productKeyFor } from '../lib/polar-products.js';
import { PLAN_SECONDS_SQL } from '../db/plan-usage.js';

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
  await tx.query('UPDATE users SET tier=$2 WHERE id=$1', [userId, tier]);
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
  const pack = CREDIT_PACKS[key];
  if (!pack) return 'ignored_product'; // Subscription orders are handled by subscription events.
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

/** Plan, minutes and credits as the app shows them. */
export async function billingState(user, db = database) {
  const tier = planOf(user);
  const [usage, credits, subscription] = await Promise.all([
    db.queryOne(`SELECT COALESCE(sum(${PLAN_SECONDS_SQL}),0)::int AS seconds FROM calls
      WHERE user_id=$1 AND NOT budget_released
      AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [user.id]),
    db.queryOne('SELECT COALESCE(sum(amount_cents),0)::int AS cents FROM credit_ledger WHERE user_id=$1', [user.id]),
    db.queryOne(`SELECT plan,billing_interval,status,current_period_end,cancel_at_period_end FROM subscriptions
      WHERE user_id=$1 AND status = ANY($2) ORDER BY (plan='business') DESC, updated_at DESC LIMIT 1`, [user.id, GRANTING]),
  ]);
  return {
    tier,
    minutes_included: PLANS[tier].minutes,
    minutes_used: Math.round(usage.seconds / 6) / 10,
    credits_cents: credits.cents,
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
