import { HttpError } from '../lib/users.js';

// Cloudflare Realtime TURN. The endpoint shape below is from memory and is
// confirmed by a later spike; keep every provider detail inside this module.
const endpoint = keyId => `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
const TTL_SECONDS = 3600;
const unavailable = () => new HttpError(503, 'turn_unavailable', 'Calling over the internet is unavailable right now.');
const validUrls = urls => (typeof urls === 'string' && urls.length > 0) || (Array.isArray(urls) && urls.length > 0 && urls.every(u => typeof u === 'string' && u.length > 0));
const validServer = server => server !== null && typeof server === 'object' && !Array.isArray(server) && validUrls(server.urls);

/**
 * Short-lived relay credentials for one call. Nothing is cached, and the API
 * token never leaves this function: every failure is the same generic 503.
 */
export async function getIceServers({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim(), token = env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId || !token) throw unavailable();
  let body;
  try {
    const response = await fetchImpl(endpoint(keyId), { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: TTL_SECONDS }) });
    if (!response.ok) throw new Error('provider status');
    body = await response.json();
  } catch {
    throw unavailable();
  }
  const servers = Array.isArray(body?.iceServers) ? body.iceServers : body?.iceServers && typeof body.iceServers === 'object' ? [body.iceServers] : null;
  if (!servers?.length || !servers.every(validServer)) throw unavailable();
  return servers;
}
