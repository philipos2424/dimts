import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
let creates = 0, reads = 0, outcome = 'confirmed', hold, release;
mock.module('../services/calendar.js', { namedExports: {
  createCalendarEvent: async () => { creates++; if (hold) await hold; return { status: outcome, error_code: outcome === 'unknown' ? 'timeout' : null }; },
  findCalendarEvent: async () => { reads++; return { status: 'confirmed', error_code: null }; },
} });
const { calendarActionsRouter } = await import('./calendar-actions.js');
const { followupsRouter } = await import('./followups.js');
const app = express(); app.use(express.json()); app.use('/calls', calendarActionsRouter); app.use('/calls', followupsRouter);
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.code ?? err.message }));
const server = app.listen(0), origin = `http://127.0.0.1:${server.address().port}`;
const tokens = ['a'.repeat(64), 'b'.repeat(64)], users = [];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING *', [`+1555555010${i}`])).rows[0];
  users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  await db.query("INSERT INTO google_connections(user_id,kind,encrypted_tokens) VALUES($1,'calendar','test-encrypted')", [user.id]);
}
const transcript = 'Caller: Meet tomorrow at two?\nUser: Yes, tomorrow at two.';
const draft = { version: 1, source_hash: createHash('sha256').update(transcript).digest('hex'), email: null,
  meeting: { title: 'Meet Phili', notes: 'Discuss pricing', time_text: 'tomorrow at two', start: '2026-10-02T14:00:00Z', end: '2026-10-02T15:00:00Z', status: 'pending',
    evidence: { quotes: transcript.split('\n'), confidence: 0.9, reason: 'Agreed by both speakers.' } } };
async function seed(changes = {}) {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,transcript,followups,followups_version)
    VALUES($1,$2,'+15555550109','ready',$3,$4,1) RETURNING id`, [users[0].id, users[0].phone, transcript, JSON.stringify({ ...draft, ...changes })])).rows[0].id;
}
async function request(id, suffix = '', method = 'POST', body = { version: 1 }, token = tokens[0]) {
  const response = await fetch(`${origin}/calls/${id}/followups/meeting/action${suffix}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
test('booking is private, reviewed and idempotent; confirmed proposal edits and rejections are locked', async () => {
  const id = await seed();
  assert.equal((await request(id, '', 'POST', { version: 1 }, null)).status, 401);
  assert.equal((await request(id, '', 'POST', { version: 1 }, tokens[1])).status, 404);
  assert.equal((await request(id, '', 'POST', { version: 0 })).status, 409);
  const before = creates;
  const result = await request(id);
  assert.equal(result.status, 200); assert.equal(result.data.action.status, 'confirmed');
  assert.match(result.data.action.event_id, /^[a-f0-9]{32}$/);
  assert.deepEqual((await request(id)).data, result.data); assert.equal(creates, before + 1);
  assert.equal((await request(id, '', 'GET', undefined, tokens[1])).status, 404);
  const edit = { ...draft, meeting: { ...draft.meeting, title: 'Changed meeting' } };
  const response = await fetch(`${origin}/calls/${id}/followups`, { method: 'PATCH', headers: { Authorization: `Bearer ${tokens[0]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(edit) });
  assert.equal(response.status, 409);
  const reject = await fetch(`${origin}/calls/${id}/followups/meeting/reject`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1 }) });
  assert.equal(reject.status, 409);
  const refresh = await fetch(`${origin}/calls/${id}/followups/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1 }) });
  assert.equal(refresh.status, 409);
});
test('uncertain results and expired in-flight actions reconcile with reads, never another create', async () => {
  outcome = 'unknown'; const id = await seed();
  const result = await request(id); assert.equal(result.data.action.status, 'unknown');
  const before = creates;
  assert.equal((await request(id)).data.action.status, 'unknown'); assert.equal(creates, before);
  assert.equal((await request(id, '/reconcile')).data.action.status, 'confirmed'); assert.equal(reads, 1);
  const crashed = await seed(); outcome = 'confirmed'; hold = new Promise(resolve => { release = resolve; });
  const creating = request(crashed);
  // Wait for the specific provider invocation, rather than relying on elapsed time.
  const deadline = Date.now() + 2000;
  while (creates === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(creates > before, 'The reserved action reached the provider mock');
  assert.equal((await request(crashed)).data.action.status, 'pending');
  assert.equal((await request(crashed, '/reconcile')).data.action.status, 'pending');
  await db.query("UPDATE calendar_actions SET lease_until=now()-interval '1 second' WHERE call_id=$1", [crashed]);
  assert.equal((await request(crashed, '/reconcile')).data.action.status, 'confirmed');
  release(); hold = undefined; await creating;
  assert.equal((await request(crashed, '', 'GET')).data.action.status, 'confirmed');
});
test('stale transcript, rejected proposal, missing evidence and incomplete times cannot dispatch', async () => {
  const cases = [{ source_hash: 'old' }, { meeting: { ...draft.meeting, status: 'rejected' } },
    { meeting: { ...draft.meeting, evidence: null } }, { meeting: { ...draft.meeting, start: '' } }];
  const before = creates;
  for (const change of cases) assert.ok((await request(await seed(change))).status >= 400);
  const id = await seed(); await db.query("UPDATE calls SET transcript='New transcript' WHERE id=$1", [id]);
  assert.equal((await request(id)).status, 409); assert.equal(creates, before);
});
test('a definite provider failure allows corrected review and another explicit attempt', async () => {
  outcome = 'failed'; const id = await seed();
  assert.equal((await request(id)).data.action.status, 'failed');
  const edit = { ...draft, meeting: { ...draft.meeting, title: 'Corrected title' } };
  const response = await fetch(`${origin}/calls/${id}/followups`, { method: 'PATCH', headers: { Authorization: `Bearer ${tokens[0]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(edit) });
  assert.equal(response.status, 200); const saved = await response.json();
  outcome = 'confirmed'; const result = await request(id, '', 'POST', { version: saved.version });
  assert.equal(result.data.action.status, 'confirmed'); assert.equal(result.data.action.meeting.title, 'Corrected title');
});
test('database failure after provider commit is recovered by lookup without a second creation', async () => {
  outcome = 'confirmed'; const id = await seed(), before = creates;
  await db.query(`ALTER TABLE calendar_actions ADD CONSTRAINT simulated_receipt_failure CHECK(call_id<>'${id}' OR status<>'confirmed')`);
  assert.equal((await request(id)).status, 500);
  assert.equal((await request(id)).data.action.status, 'pending'); assert.equal(creates, before + 1);
  await db.query('ALTER TABLE calendar_actions DROP CONSTRAINT simulated_receipt_failure');
  await db.query("UPDATE calendar_actions SET lease_until=now()-interval '1 second' WHERE call_id=$1", [id]);
  assert.equal((await request(id, '/reconcile')).data.action.status, 'confirmed'); assert.equal(creates, before + 1);
});
