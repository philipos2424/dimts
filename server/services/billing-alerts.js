import { query, queryOne } from '../db/pool.js';
import { billingState } from './billing.js';
import { currentMonth } from '../lib/users.js';

const SEND = 'https://exp.host/--/api/v2/push/send';
const headers = () => ({ 'Content-Type': 'application/json', Accept: 'application/json',
  ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) });

/** Credits below this, once someone has bought credits, earn a warning. */
export const LOW_CREDIT_CENTS = 200;

// Push only reaches the native apps, where store rules forbid prompting for outside purchases.
const TEXT = {
  en: {
    minutes80: (left) => ({ title: 'Plan minutes running low', body: `${left} minutes left this month. Calls after that use credits.` }),
    minutes100: () => ({ title: 'Plan minutes used up', body: 'Calls now use your credits.' }),
    creditsLow: (left) => ({ title: 'Credits running low', body: `${left} of credit left.` }),
    missed: () => ({ title: 'A caller reached your voicemail', body: 'You are out of minutes and credits, so the call went to voicemail.' }),
  },
  am: {
    minutes80: (left) => ({ title: 'የዕቅድ ደቂቃ እያለቀ ነው', body: `በዚህ ወር ${left} ደቂቃ ቀርቷል።` }),
    minutes100: () => ({ title: 'የዕቅድ ደቂቃ አልቋል', body: 'ጥሪዎች አሁን ክሬዲት ይጠቀማሉ።' }),
    creditsLow: (left) => ({ title: 'ክሬዲት እያለቀ ነው', body: `${left} ክሬዲት ቀርቷል።` }),
    missed: () => ({ title: 'ደዋይ ወደ ድምፅ መልዕክት ሄደ', body: 'ደቂቃ እና ክሬዲት ስላለቀብዎ ጥሪው ወደ ድምፅ መልዕክት ሄዷል።' }),
  },
};

const money = cents => `US$${(cents / 100).toFixed(2)}`;

/** Records the alert and reports whether it is new; each key is sent at most once. */
async function claim(userId, key) {
  return Boolean(await queryOne('INSERT INTO billing_alerts(user_id,alert_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING alert_key', [userId, key]));
}

async function push(userId, message, type) {
  const { rows } = await query(`SELECT d.push_token FROM notification_devices d JOIN sessions s ON s.token_hash=d.session_hash
    WHERE d.user_id=$1 AND NOT d.disabled AND s.expires_at>now()`, [userId]);
  if (!rows.length) return false;
  const response = await fetch(SEND, { method: 'POST', headers: headers(), signal: AbortSignal.timeout(5000),
    body: JSON.stringify(rows.map(row => ({ to: row.push_token, title: message.title, body: message.body, data: { type } }))) });
  return response.ok;
}

/**
 * Warn before a call is refused, not after: at 80% and 100% of plan minutes,
 * and when bought credits run low. Best effort; never throws.
 */
export async function sendBalanceAlerts(userId, now = new Date()) {
  try {
    const user = await queryOne('SELECT id, tier, language FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
    if (!user) return [];
    const t = TEXT[user.language] ?? TEXT.en;
    const state = await billingState(user);
    const month = currentMonth(now);
    const sent = [];
    const left = Math.max(0, Math.floor(state.minutes_included - state.minutes_used));
    // A Free account after its trial has no plan minutes to run low on.
    if (state.minutes_included <= 0) { /* no minute alerts */ }
    else if (state.minutes_used >= state.minutes_included) {
      if (await claim(userId, `minutes100:${month}`)) sent.push(['minutes100', t.minutes100()]);
    } else if (state.minutes_used >= state.minutes_included * 0.8) {
      if (await claim(userId, `minutes80:${month}`)) sent.push(['minutes80', t.minutes80(left)]);
    }
    if (state.credits_cents < LOW_CREDIT_CENTS) {
      // Re-arms after every purchase, so each top-up earns one warning.
      const { purchases } = await queryOne(`SELECT count(*)::int AS purchases FROM credit_ledger WHERE user_id=$1 AND reason='purchase'`, [userId]);
      if (purchases > 0 && await claim(userId, `credits_low:${purchases}`)) sent.push(['credits_low', t.creditsLow(money(state.credits_cents))]);
    }
    for (const [type, message] of sent) await push(userId, message, `billing-${type}`);
    return sent.map(([type]) => type);
  } catch (err) {
    console.error('[billing] balance alert failed', err?.message);
    return [];
  }
}

/** A caller was sent to voicemail because the owner ran out; at most one push a day. */
export async function sendMissedForBalanceAlert(userId, now = new Date()) {
  try {
    const user = await queryOne('SELECT language FROM users WHERE id=$1', [userId]);
    if (!user || !await claim(userId, `missed:${now.toISOString().slice(0, 10)}`)) return false;
    return await push(userId, (TEXT[user.language] ?? TEXT.en).missed(), 'billing-missed');
  } catch (err) {
    console.error('[billing] missed-call alert failed', err?.message);
    return false;
  }
}
