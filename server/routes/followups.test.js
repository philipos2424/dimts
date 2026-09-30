import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { parseFollowups, validateReviewedFollowups } from '../services/followups.js';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const alice = (await db.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING id")).rows[0];
const bob = (await db.query("INSERT INTO users(phone) VALUES('+15555550102') RETURNING id")).rows[0];
const call = (await db.query("INSERT INTO calls(user_id,user_phone,destination,transcript) VALUES($1,'+15555550101','+15555550103','User: Yes tomorrow at two.') RETURNING id", [alice.id])).rows[0];
let generations = 0;
mock.module('../db/pool.js', { namedExports: { queryOne: async (sql, params) => (await db.query(sql, params)).rows[0] } });
mock.module('../lib/users.js', { namedExports: {
  resolveUser: async req => req.get('x-test-owner') === 'bob' ? bob : alice,
  HttpError: class extends Error { constructor(status, code) { super(code); this.status = status; } },
} });
mock.module('../services/followups.js', { namedExports: {
  validateReviewedFollowups,
  generateFollowups: async () => { generations++; return parseFollowups(JSON.stringify({ email: { subject: 'Follow-up', body: 'Thank you.' }, meeting: { title: 'Meeting', notes: 'Confirm AM/PM', time_text: 'tomorrow at two' } })); },
} });
const { followupsRouter } = await import('./followups.js');
const app = express(); app.use(express.json()); app.use('/calls', followupsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
test.after(() => db.close());
async function request(method, owner = 'alice', body) {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/calls/${call.id}/followups`, {
      method, headers: { 'Content-Type': 'application/json', 'x-test-owner': owner }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  } finally { server.close(); }
}
test('drafts preserve ambiguous times; repeated generation retains reviewed edits', async () => {
  const result = await request('POST');
  assert.equal(result.status, 200);
  assert.equal(result.data.meeting.time_text, 'tomorrow at two');
  assert.equal(result.data.meeting.start, '');
  result.data.email.body = 'My reviewed message';
  result.data.email.recipient = 'phili@example.com';
  assert.equal((await request('PATCH', 'alice', result.data)).status, 200);
  assert.equal((await request('POST')).data.email.body, 'My reviewed message');
  assert.equal(generations, 1);
});
test('other accounts cannot generate or overwrite drafts', async () => {
  assert.equal((await request('POST', 'bob')).status, 404);
  assert.equal((await request('PATCH', 'bob', { email: null, meeting: null })).status, 404);
  assert.equal(generations, 1);
});
test('calendar review rejects rolled dates, missing timezone and backwards intervals', () => {
  const draft = { email: null, meeting: { title: 'Meet', notes: '', time_text: 'tomorrow', start: '2026-02-30T14:00:00Z', end: '' } };
  assert.throws(() => validateReviewedFollowups(draft));
  draft.meeting.start = '2026-10-02T14:00:00';
  assert.throws(() => validateReviewedFollowups(draft));
  draft.meeting.start = '2026-10-02T14:00:00Z'; draft.meeting.end = '2026-10-02T13:00:00Z';
  assert.throws(() => validateReviewedFollowups(draft));
  draft.meeting.end = '2026-10-02T15:00:00Z';
  assert.equal(validateReviewedFollowups(draft).meeting.end, draft.meeting.end);
});
test('email review rejects header injection and multiple recipients', () => {
  for (const recipient of ['a@example.com\r\nBcc:x@example.com', 'a@example.com,b@example.com']) {
    assert.throws(() => validateReviewedFollowups({ email: { subject: 'Hi', body: 'Hi', recipient }, meeting: null }));
  }
});
