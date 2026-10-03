import { query } from '../db/pool.js';
import { briefingText } from './briefing.js';

const SEND = 'https://exp.host/--/api/v2/push/send';
const headers = () => ({ 'Content-Type': 'application/json', Accept: 'application/json',
  ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) });
/** Monday nudge with what is waiting this week. Returns whether a push was sent. */
export async function sendBriefingNotification(userId, briefing, language = 'en') {
  try {
    const { rows } = await query(`SELECT d.push_token FROM notification_devices d JOIN sessions s ON s.token_hash=d.session_hash
      WHERE d.user_id=$1 AND NOT d.disabled AND s.expires_at>now()`, [userId]);
    if (!rows.length) return false;
    const t = briefingText(language);
    const body = t.push(briefing.totals.you_owe, briefing.totals.waiting_on, briefing.totals.money) || briefing.next_moves[0]?.move;
    if (!body) return false;
    const response = await fetch(SEND, { method: 'POST', headers: headers(), signal: AbortSignal.timeout(5000),
      body: JSON.stringify(rows.map(row => ({ to: row.push_token, title: t.heading, body, data: { type: 'weekly-briefing' } }))) });
    return response.ok;
  } catch (err) {
    console.error('[notifications] briefing push failed', err?.message);
    return false;
  }
}
