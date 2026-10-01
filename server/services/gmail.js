import { googleAccessToken, googleSender } from './google-oauth.js';

const base = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';
const normalize = value => value.replace(/\r\n?/g, '\n');
function encodedSubject(text) {
  const chunks = []; let chunk = '';
  for (const char of text) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 30) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
}
export function gmailRaw(action, sender) {
  const email = action.email;
  if (!sender || /[\r\n<>]/.test(sender) || !email.recipient || /[\r\n]/.test(email.recipient) || /[\r\n]/.test(email.subject)) throw new Error('Invalid mail headers');
  const body = Buffer.from(normalize(email.body).replaceAll('\n', '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const raw = `From: ${sender}\r\nTo: ${email.recipient}\r\nSubject: ${encodedSubject(email.subject)}\r\nMessage-ID: <${action.message_key}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`;
  return Buffer.from(raw).toString('base64url');
}
function matches(draft, action, sender) {
  if (typeof draft.id !== 'string' || !draft.id || typeof draft.message?.raw !== 'string') return false;
  const raw = normalize(Buffer.from(draft.message.raw, 'base64url').toString('utf8'));
  const split = raw.indexOf('\n\n'); if (split < 0) return false;
  const headers = new Map();
  for (const line of raw.slice(0, split).replace(/\n[ \t]+/g, ' ').split('\n')) {
    const separator = line.indexOf(':'); if (separator < 1) return false;
    const name = line.slice(0, separator).toLowerCase(), value = line.slice(separator + 1).trim();
    if (headers.has(name)) return false;
    headers.set(name, value);
  }
  const subject = headers.get('subject')?.replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_match, data) => Buffer.from(data, 'base64').toString('utf8'));
  if (headers.get('message-id') !== `<${action.message_key}>` || headers.get('from') !== sender || headers.get('to') !== action.email.recipient ||
      subject !== action.email.subject || headers.get('content-transfer-encoding')?.toLowerCase() !== 'base64' ||
      !/^text\/plain;\s*charset="?UTF-8"?$/i.test(headers.get('content-type') ?? '')) return false;
  return normalize(Buffer.from(raw.slice(split + 2).replace(/\s/g, ''), 'base64').toString('utf8')) === normalize(action.email.body);
}
async function request(url, token, method = 'GET', body) {
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw Object.assign(new Error('Gmail request failed'), { httpStatus: response.status });
  return response.json();
}
async function run(action, create) {
  let token, sender;
  try { sender = await googleSender(action.user_id, action.connection_id); token = await googleAccessToken(action.user_id, 'gmail', action.connection_id); }
  catch (err) { return { status: create ? 'failed' : 'unknown', error_code: err.code ?? 'google_unavailable' }; }
  let dispatched = false, postAccepted = false;
  try {
    let id;
    if (create) {
      const raw = gmailRaw(action, sender); dispatched = true;
      const result = await request(base, token, 'POST', { message: { raw } });
      postAccepted = true;
      id = result.id;
    } else {
      const query = new URLSearchParams({ q: `rfc822msgid:<${action.message_key}>`, maxResults: '2', includeSpamTrash: 'true' });
      const result = await request(`${base}?${query}`, token);
      if (!Array.isArray(result.drafts) || result.drafts.length !== 1 || result.nextPageToken) return { status: 'unknown', error_code: 'gmail_draft_not_unique' };
      id = result.drafts[0].id;
    }
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) return { status: 'unknown', error_code: 'gmail_invalid_receipt' };
    // After dispatch, even a failed lookup must not release the reservation.
    const draft = await request(`${base}/${encodeURIComponent(id)}?format=raw`, token);
    if (draft.id !== id || !matches(draft, action, sender)) return { status: 'unknown', error_code: 'gmail_draft_mismatch' };
    return { status: 'confirmed', draft_id: id, error_code: null };
  } catch (err) {
    const definitive = create && (!dispatched || (!postAccepted && [400,401,403,404,422].includes(err.httpStatus)));
    return { status: definitive ? 'failed' : 'unknown', error_code: err.httpStatus ? `gmail_http_${err.httpStatus}` : 'gmail_result_unknown' };
  }
}
export const createGmailDraft = action => run(action, true);
export const findGmailDraft = action => run(action, false);
