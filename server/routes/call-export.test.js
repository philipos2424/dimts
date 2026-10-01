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
} });
const { callsRouter } = await import('./calls.js');
const app = express(); app.use('/calls', callsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'internal_error' }));
const server = app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
const users = [], tokens = ['a'.repeat(64), 'b'.repeat(64)];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [`+1555555010${i}`])).rows[0];
  users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash('sha256').update(token).digest('hex'), user.id]);
}
const contact = (await db.query("INSERT INTO contacts(user_id,phone,display_name) VALUES($1,'+15555550103','ፊሊ') RETURNING id", [users[0].id])).rows[0];
const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,duration_sec,
  direction,transcript,summary,action_items,key_points,next_moves,recording_url,twilio_call_sid,transcript_data)
  VALUES($1,'+15555550100','+15555550103',$2,'ready',90,'inbound','Caller: ሰላም\nUser: Hello','Pricing discussed',
    '[{"task":"Send price","owner":"User"}]','["Price not yet accepted"]','["Review pricing"]',
    'secret-provider-url','secret-provider-sid','{"secret":"private-provider-payload"}') RETURNING id`, [users[0].id, contact.id])).rows[0];
function request(token = tokens[0]) {
  return fetch(`${base}/calls/${call.id}/notes`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });

test('exports complete UTF-8 notes and speaker text without provider metadata or execution claims', async () => {
  const response = await request(), text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain; charset=utf-8/i);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="dimts-call-${call.id}.txt"`);
  for (const expected of ['ፊሊ', 'Caller: ሰላም\nUser: Hello', 'Pricing discussed', 'Price not yet accepted',
    'Send price (owner: User)', 'Review pricing', 'not proof of completed actions', 'may contain errors']) assert.ok(text.includes(expected));
  assert.doesNotMatch(text, /secret-provider|private-provider-payload|Bearer/);
});

test('other accounts, expired sessions and unsigned requests cannot export notes', async () => {
  assert.equal((await request(tokens[1])).status, 404);
  assert.equal((await request(null)).status, 401);
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [createHash('sha256').update(tokens[0]).digest('hex')]);
  assert.equal((await request()).status, 401);
  await db.query("UPDATE sessions SET expires_at=now()+interval '1 day' WHERE token_hash=$1", [createHash('sha256').update(tokens[0]).digest('hex')]);
});

test('unrecorded or failed calls can export metadata without inventing a transcript', async () => {
  await db.query("UPDATE calls SET status='completed',transcript=NULL,summary=NULL,action_items=NULL,key_points=NULL,next_moves=NULL WHERE id=$1", [call.id]);
  const response = await request(), text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /No transcript is available/);
  assert.match(text, /notes are incomplete/); assert.doesNotMatch(text, /Pricing discussed/);
});
