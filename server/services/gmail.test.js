import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
let connected = true;
const sender = 'owner@example.com';
mock.module('./google-oauth.js', { namedExports: {
  googleSender: async () => { if (!connected) throw Object.assign(new Error(), { code: 'gmail_reconnect_required' }); return sender; },
  googleAccessToken: async () => 'private-token',
} });
const { createGmailDraft, findGmailDraft, gmailRaw } = await import('./gmail.js');
const action = { id: 'action', user_id: 'owner', connection_id: 'grant', message_key: 'dimts-unique@dimts.invalid',
  email: { recipient: 'phili@example.com', subject: 'የስብሰባ ማስታወሻ — meeting notes', body: 'Thank you, Phili.\nI will send the recap.' } };
const saved = () => ({ id: 'draft-1', message: { id: 'message-1', raw: gmailRaw(action, sender) } });
test.afterEach(() => { mock.restoreAll(); connected = true; });
test('creates a Unicode MIME draft, validates saved content and never invokes a send endpoint', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, method: init.method }); assert.equal(init.redirect, 'error');
    if (init.method === 'POST') {
      assert.ok(url.endsWith('/drafts')); const raw = Buffer.from(JSON.parse(init.body).message.raw, 'base64url').toString();
      assert.ok(raw.startsWith(`From: ${sender}\r\nTo: ${action.email.recipient}`));
      assert.ok(raw.includes(`Message-ID: <${action.message_key}>`));
      assert.ok(raw.split('\r\n').every(line => line.length <= 78));
      return Response.json({ id: 'draft-1' });
    }
    assert.ok(url.endsWith('/draft-1?format=raw')); return Response.json(saved());
  });
  assert.deepEqual(await createGmailDraft(action), { status: 'confirmed', draft_id: 'draft-1', error_code: null });
  assert.deepEqual(calls.map(c => c.method), ['POST', 'GET']); assert.ok(calls.every(c => !c.url.includes('/send')));
});
test('failed read after successful creation and network loss both retain an uncertain reservation', async () => {
  mock.method(globalThis, 'fetch', async (_url, init) => init.method === 'POST' ? Response.json({ id: 'draft-1' }) : new Response('', { status: 404 }));
  assert.equal((await createGmailDraft(action)).status, 'unknown');
  mock.restoreAll(); mock.method(globalThis, 'fetch', async () => { throw new Error('private-token must not leak'); });
  assert.deepEqual(await createGmailDraft(action), { status: 'unknown', error_code: 'gmail_result_unknown' });
});
test('reconciliation searches the original Message-ID and verifies exactly one matching draft using reads', async () => {
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'GET'); assert.ok(!init.body);
    if (url.includes('?q=')) {
      assert.equal(new URL(url).searchParams.get('q'), `rfc822msgid:<${action.message_key}>`);
      return Response.json({ drafts: [{ id: 'draft-1' }] });
    }
    return Response.json(saved());
  });
  assert.equal((await findGmailDraft(action)).status, 'confirmed');
});
test('missing, multiple and modified drafts remain unknown instead of enabling another create', async () => {
  for (const drafts of [[], [{ id: 'one' }, { id: 'two' }]]) {
    mock.method(globalThis, 'fetch', async () => Response.json({ drafts }));
    assert.equal((await findGmailDraft(action)).status, 'unknown'); mock.restoreAll();
  }
  mock.method(globalThis, 'fetch', async (url, init) => init.method === 'POST' ? Response.json({ id: 'draft-1' }) : Response.json({ ...saved(), message: { raw: gmailRaw({ ...action, email: { ...action.email, recipient: 'someone@example.com' } }, sender) } }));
  assert.equal((await createGmailDraft(action)).error_code, 'gmail_draft_mismatch');
});
test('header injection and missing verified sender never dispatch; definite creation refusal is retryable', async () => {
  assert.throws(() => gmailRaw({ ...action, email: { ...action.email, recipient: 'x@example.com\r\nBcc:other@example.com' } }, sender));
  assert.throws(() => gmailRaw(action, 'owner@example.com\r\nBcc:other@example.com'));
  connected = false; const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected'); });
  assert.equal((await createGmailDraft(action)).status, 'failed'); assert.equal(fetchMock.mock.callCount(), 0);
  connected = true; mock.restoreAll(); mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  assert.equal((await createGmailDraft(action)).status, 'failed');
});
