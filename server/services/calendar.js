import { googleAccessToken } from './google-oauth.js';

const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
async function request(action, method) {
  // Token failures occur before a request is dispatched and cannot create an event.
  let token;
  try { token = await googleAccessToken(action.user_id, 'calendar', action.connection_id); }
  catch (err) { return { status: method === 'POST' ? 'failed' : 'unknown', error_code: err.code ?? 'google_unavailable' }; }
  const meeting = action.meeting;
  const data = { id: action.event_id, summary: meeting.title, description: meeting.notes,
    start: { dateTime: meeting.start }, end: { dateTime: meeting.end },
    extendedProperties: { private: { dimts_action: action.id } } };
  try {
    const response = await fetch(method === 'POST' ? base : `${base}/${action.event_id}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok) {
      // A conflict may be a previously committed request. Reconciliation uses GET.
      const definite = method === 'POST' && [400, 401, 403, 404, 422].includes(response.status);
      return { status: definite ? 'failed' : 'unknown', error_code: `google_http_${response.status}` };
    }
    const event = await response.json();
    if (event.id !== action.event_id || event.status === 'cancelled' ||
        event.extendedProperties?.private?.dimts_action !== action.id ||
        event.summary !== meeting.title || (event.description ?? '') !== meeting.notes ||
        Date.parse(event.start?.dateTime) !== Date.parse(meeting.start) ||
        Date.parse(event.end?.dateTime) !== Date.parse(meeting.end)) {
      return { status: 'unknown', error_code: 'google_event_mismatch' };
    }
    let eventUrl = null;
    try { const url = new URL(event.htmlLink); if (url.protocol === 'https:' && url.hostname === 'www.google.com' && url.pathname.startsWith('/calendar/')) eventUrl = url.href;
      else if (url.protocol === 'https:' && url.hostname === 'calendar.google.com') eventUrl = url.href; } catch {}
    return { status: 'confirmed', event_url: eventUrl, error_code: null };
  } catch { return { status: 'unknown', error_code: 'google_result_unknown' }; }
}
export const createCalendarEvent = action => request(action, 'POST');
export const findCalendarEvent = action => request(action, 'GET');
