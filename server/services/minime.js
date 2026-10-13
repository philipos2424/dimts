import { randomUUID } from 'node:crypto';
import { signWebhook } from '../lib/standard-webhooks.js';

/**
 * MiniMe is the owner's Telegram business assistant (a separate app). Both
 * sides sign requests with the shared MINIME_LINK_SECRET in the Standard
 * Webhooks format. The link is off until MINIME_BASE_URL and the secret are set.
 */
export const minimeConfigured = () => !!(process.env.MINIME_BASE_URL && process.env.MINIME_LINK_SECRET);
export const minimeBotUsername = () => process.env.MINIME_BOT_USERNAME || 'MiniMeAgentBot';

export async function minimePost(payload, { signal, path = '/api/dimts/send' } = {}) {
  if (!minimeConfigured()) throw new Error('MiniMe link is not configured');
  const body = JSON.stringify(payload);
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${process.env.MINIME_BASE_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
      'webhook-signature': signWebhook(process.env.MINIME_LINK_SECRET, id, timestamp, body) },
    body,
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`MiniMe returned HTTP ${response.status}`), {
    status: response.status, code: typeof data.error === 'string' ? data.error : 'minime_unavailable',
  });
  return data;
}
