import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
let connected = true;
mock.module('./google-oauth.js', { namedExports: {
  googleAccessToken: async () => { if (!connected) throw Object.assign(new Error(), { code: 'google_connection_changed' }); return 'private-test-token'; },
} });
const { createCalendarEvent, findCalendarEvent } = await import('./calendar.js');
const action = { id: 'action-one', event_id: 'event123', user_id: 'owner', connection_id: 'grant',
  meeting: { title: 'Meet Phili', notes: 'Pricing discussion', start: '2026-10-02T14:00:00Z', end: '2026-10-02T15:00:00Z' } };
const event = { id: action.event_id, summary: action.meeting.title, description: action.meeting.notes,
  start: { dateTime: action.meeting.start }, end: { dateTime: action.meeting.end },
  extendedProperties: { private: { dimts_action: action.id } }, htmlLink: 'https://calendar.google.com/calendar/event?eid=event123' };
test.afterEach(() => { mock.restoreAll(); connected = true; });
test('creates a primary-calendar event with saved ID and verifies the provider response', async () => {
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://www.googleapis.com/calendar/v3/calendars/primary/events');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    const payload = JSON.parse(init.body);
    assert.equal(payload.id, action.event_id); assert.ok(!payload.attendees);
    assert.equal(payload.extendedProperties.private.dimts_action, action.id);
    return Response.json(event);
  });
  assert.deepEqual(await createCalendarEvent(action), { status: 'confirmed', event_url: event.htmlLink, error_code: null });
});
test('network loss and conflict remain uncertain; reconciliation only reads the saved event ID', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('token=private-test-token'); });
  assert.equal((await createCalendarEvent(action)).status, 'unknown');
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => new Response('', { status: 409 }));
  assert.equal((await createCalendarEvent(action)).status, 'unknown');
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'GET'); assert.ok(url.endsWith('/event123')); assert.ok(!init.body);
    return Response.json(event);
  });
  assert.equal((await findCalendarEvent(action)).status, 'confirmed');
});
test('provider refusal is distinct from absent or mismatched uncertain results', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  assert.equal((await createCalendarEvent(action)).status, 'failed');
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  assert.equal((await findCalendarEvent(action)).status, 'unknown');
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => Response.json({ ...event, summary: 'Someone changed it' }));
  assert.equal((await findCalendarEvent(action)).error_code, 'google_event_mismatch');
});
test('connection errors never dispatch a creation request and external event links are not returned', async () => {
  connected = false;
  const fetched = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected'); });
  assert.equal((await createCalendarEvent(action)).status, 'failed'); assert.equal(fetched.mock.callCount(), 0);
  connected = true; mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => Response.json({ ...event, htmlLink: 'https://attacker.example/token' }));
  const result = await createCalendarEvent(action);
  assert.equal(result.status, 'confirmed'); assert.equal(result.event_url, null);
});
