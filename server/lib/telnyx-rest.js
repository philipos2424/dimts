import { config } from '../config.js';

const API = 'https://api.telnyx.com/v2';

const snakeToCamel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function camelKeys(value) {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [snakeToCamel(k), camelKeys(v)]));
}
// Callers pass Twilio SDK style options (recordingStatusCallback); TeXML takes
// the REST names (RecordingStatusCallback). Event lists are space separated.
function pascalParams(params = {}) {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k[0].toUpperCase() + k.slice(1), Array.isArray(v) ? v.join(' ') : v]));
}

export async function telnyxRequest(method, path, { json, form, timeout = 10_000, signal } = {}) {
  const headers = { Authorization: `Bearer ${config.telnyxApiKey}`, Accept: 'application/json' };
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])); }
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(`${API}${path}`, {
    method, headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const first = data?.errors?.[0];
    throw Object.assign(new Error(first?.detail || first?.title || `Telnyx request failed (HTTP ${response.status})`),
      { status: response.status, code: first?.code });
  }
  return camelKeys(data?.data ?? data);
}

/**
 * The subset of the Twilio REST client Dimts uses, over Telnyx's
 * Twilio-compatible TeXML endpoints. Responses come back camelCased so the
 * calling code reads `accountSid`, `callSid`, `status` and `duration` as before.
 */
export function telnyxRest({ timeout = 10_000 } = {}, account = config.providerAccountSid) {
  const base = `/texml/Accounts/${encodeURIComponent(account)}`;
  const id = value => encodeURIComponent(value);
  const calls = sid => ({
    fetch: () => telnyxRequest('GET', `${base}/Calls/${id(sid)}`, { timeout }),
    update: params => telnyxRequest('POST', `${base}/Calls/${id(sid)}`, { form: pascalParams(params), timeout }),
    recordings: {
      create: params => telnyxRequest('POST', `${base}/Calls/${id(sid)}/Recordings.json`, { form: pascalParams(params), timeout }),
      list: async () => (await telnyxRequest('GET', `${base}/Calls/${id(sid)}/Recordings.json`, { timeout }))?.recordings ?? [],
    },
  });
  calls.create = async params => {
    const created = await telnyxRequest('POST', `${base}/Calls`, {
      json: { ApplicationSid: config.telnyxTexmlAppId, ...pascalParams(params) }, timeout,
    });
    // The documented response omits the SID; when absent, the first webhook supplies it.
    return { ...created, sid: created?.sid ?? created?.callSid ?? null };
  };
  const recordings = sid => ({
    fetch: () => telnyxRequest('GET', `${base}/Recordings/${id(sid)}.json`, { timeout }),
    remove: () => telnyxRequest('DELETE', `${base}/Recordings/${id(sid)}.json`, { timeout }),
  });
  return { calls, recordings };
}
