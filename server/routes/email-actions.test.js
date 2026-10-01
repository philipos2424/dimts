import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0], withTransaction: work => db.transaction(work),
} });
let creates = 0, reads = 0, outcome = 'confirmed';
mock.module('../services/gmail.js', { namedExports: {
  createGmailDraft: async () => { creates++; return { status: outcome, draft_id: outcome === 'confirmed' ? 'saved-draft-1' : null }; },
  findGmailDraft: async () => { reads++; return { status: 'confirmed', draft_id: 'saved-draft-1' }; },
} });
const { emailActionsRouter } = await import('./email-actions.js');
const { followupsRouter } = await import('./followups.js');
const app = express(); app.use(express.json()); app.use('/calls', emailActionsRouter); app.use('/calls', followupsRouter);
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.code ?? err.message }));
const server = app.listen(0), origin = `http://127.0.0.1:${server.address().port}`;
const tokens = ['a'.repeat(64), 'b'.repeat(64)], users = [];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING *', [`+1555555010${i}`])).rows[0]; users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  await db.query("INSERT INTO google_connections(user_id,kind,encrypted_tokens) VALUES($1,'gmail','test-encrypted')", [user.id]);
}
const transcript = 'User: I will email a recap.';
const draft = { version: 1, source_hash: createHash('sha256').update(transcript).digest('hex'), meeting: null,
  email: { subject: 'Call recap', body: 'Thank you for the call.', recipient: 'phili@example.com', status: 'pending',
    evidence: { quotes: [transcript], confidence: 0.9, reason: 'User promised email.' } } };
async function seed(changes = {}) {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,transcript,followups,followups_version)
    VALUES($1,$2,'+15555550109','ready',$3,$4,1) RETURNING id`, [users[0].id, users[0].phone, transcript, JSON.stringify({ ...draft, ...changes })])).rows[0].id;
}
async function request(id, suffix = '/email/action', method = 'POST', body = { version: 1 }, token = tokens[0]) {
  const response = await fetch(`${origin}/calls/${id}/followups${suffix}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
test('reviewed Gmail draft creation is authenticated, private, idempotent and immutable after confirmation', async () => {
  const id = await seed(), before = creates;
  assert.equal((await request(id, undefined, 'POST', undefined, null)).status, 401);
  assert.equal((await request(id, undefined, 'POST', undefined, tokens[1])).status, 404);
  assert.equal((await request(id, undefined, 'POST', { version: 0 })).status, 409);
  const result = await request(id); assert.equal(result.data.action.status, 'confirmed'); assert.equal(result.data.action.draft_id, 'saved-draft-1');
  assert.deepEqual((await request(id)).data, result.data); assert.equal(creates, before + 1);
  assert.equal((await request(id, undefined, 'GET', undefined, tokens[1])).status, 404);
  assert.equal((await request(id, '', 'PATCH', { ...draft, email: { ...draft.email, body: 'Overwritten' } })).status, 409);
  assert.equal((await request(id, '/email/reject')).status, 409);
  assert.equal((await request(id, '/refresh')).status, 409);
});
test('uncertain and crashed actions are reconciled by reading without another creation', async () => {
  outcome = 'unknown'; const id = await seed(); await request(id); const before = creates;
  assert.equal((await request(id)).data.action.status, 'unknown'); assert.equal(creates, before);
  assert.equal((await request(id, '/email/action/reconcile')).data.action.status, 'confirmed'); assert.equal(reads, 1);
  outcome = 'confirmed'; const crashed = await seed();
  await db.query(`ALTER TABLE email_actions ADD CONSTRAINT simulated_email_receipt_failure CHECK(call_id<>'${crashed}' OR status<>'confirmed')`);
  assert.equal((await request(crashed)).status, 500); assert.equal((await request(crashed)).data.action.status, 'pending');
  const afterDispatch = creates;
  await db.query('ALTER TABLE email_actions DROP CONSTRAINT simulated_email_receipt_failure');
  await db.query("UPDATE email_actions SET lease_until=now()-interval '1 second' WHERE call_id=$1", [crashed]);
  assert.equal((await request(crashed, '/email/action/reconcile')).data.action.status, 'confirmed'); assert.equal(creates, afterDispatch);
});
test('rejected, incomplete, stale and injected proposals cannot reach Gmail', async () => {
  const before = creates;
  for (const changes of [{ source_hash: 'old' }, { email: { ...draft.email, status: 'rejected' } },
    { email: { ...draft.email, evidence: null } }, { email: { ...draft.email, recipient: '' } },
    { email: { ...draft.email, subject: 'Hi\r\nBcc:attacker@example.com' } }]) assert.ok((await request(await seed(changes))).status >= 400);
  assert.equal(creates, before);
});
test('definite provider refusal permits an edited proposal and an explicit retry', async () => {
  outcome = 'failed'; const id = await seed(); assert.equal((await request(id)).data.action.status, 'failed');
  const edit = await request(id, '', 'PATCH', { ...draft, email: { ...draft.email, subject: 'Corrected recap' } });
  assert.equal(edit.status, 200); outcome = 'confirmed';
  const result = await request(id, undefined, 'POST', { version: edit.data.version });
  assert.equal(result.data.action.status, 'confirmed'); assert.equal(result.data.action.email.subject, 'Corrected recap');
});
