import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openRows } from '../lib/field-crypto.js';

process.env.MINIME_FILE_ACTIONS = '1';
process.env.DATA_ENCRYPTION_KEYS = `test:${Buffer.alloc(32, 7).toString('base64')}`;
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: async (sql, p) => openRows(await db.query(sql, p)),
  queryOne: async (sql, p) => openRows(await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(tx => work({ query: async (sql, p) => openRows(await tx.query(sql, p)) })),
} });
const transcript = 'Caller: Send me the price list on Telegram.\nUser: Yes.\nCaller: And the catalog on WhatsApp.';
let detections = 0, sends = 0, remoteState = 'sent', changed = false, hold, release;
mock.module('../services/file-requests.js', { namedExports: { detectFileRequests: async () => {
  detections++; return [
    { request: 'Price list', channel: 'telegram', caption: '', evidence: [transcript.split('\n')[0]] },
    { request: 'Catalog', channel: 'whatsapp', caption: '', evidence: [transcript.split('\n')[2]] },
  ];
} } });
const file = { id: '00000000-0000-4000-8000-000000000002', name: 'prices.pdf', bytes: 100 };
const recipient = { id: '00000000-0000-4000-8000-000000000003', name: 'Customer', phone: '+15555550109' };
mock.module('../services/minime.js', { namedExports: {
  minimeConfigured: () => true,
  minimePost: async body => {
    if (body.operation === 'options') return { files: [file], recipients: [recipient] };
    if (body.operation === 'prepare') return { file, recipient, caption: body.caption || '', approval_hash: 'a'.repeat(64), preview_url: 'https://example.test/preview' };
    if (body.operation === 'send') {
      sends++; if (hold) await hold;
      if (changed) throw Object.assign(new Error('selection_changed'), { status: 409, code: 'selection_changed' });
      if (remoteState === 'timeout') throw new Error('timeout');
    }
    return { status: remoteState, message_id: remoteState === 'sent' ? 123 : null };
  },
} });
const { fileActionsRouter } = await import('./file-actions.js');
const { assertDeletable, scrubCall } = await import('../services/scrub-call.js');
const app = express(); app.use(express.json()); app.use('/calls', fileActionsRouter);
app.use((e, _q, r, _n) => r.status(e.status || 500).json({ error: e.code || e.message }));
const server = app.listen(0), origin = `http://127.0.0.1:${server.address().port}`;
const users = [], tokens = ['a'.repeat(64), 'b'.repeat(64)];
for (const [i, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING *', [`+1555555010${i}`])).rows[0];
  users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(token).digest('hex'), user.id]);
  await db.query('INSERT INTO minime_links(user_id,business_id) VALUES($1,$2)', [user.id, `business-${i}`]);
}
async function call() {
  return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,transcript,duration_sec,budget_released)
    VALUES($1,$2,'+15555550109','ready',$3,60,true) RETURNING *`, [users[0].id, users[0].phone, transcript])).rows[0];
}
async function request(id, suffix = '', body = undefined, token = tokens[0]) {
  const r = await fetch(`${origin}/calls/${id}/file-actions${suffix}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
async function prepared() {
  const source = await call(); const found = await request(source.id, '/prepare', {});
  assert.equal(found.status, 200, JSON.stringify(found.data));
  const candidate = found.data.actions[0];
  const review = await request(source.id, `/${candidate.id}/review`, { version: candidate.version, document_id: file.id, customer_id: recipient.id, caption: 'As requested' });
  assert.equal(review.status, 200, JSON.stringify(review.data));
  return { source, action: review.data.action };
}
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
test('multiple actions are private, preserved on repeat extraction and encrypted at rest', async () => {
  const source = await call();
  assert.equal((await request(source.id, '', undefined, null)).status, 401);
  assert.equal((await request(source.id, '/prepare', {}, tokens[1])).status, 404);
  const before = detections;
  const found = await request(source.id, '/prepare', {});
  assert.equal(found.data.actions.length, 2);
  const again = await request(source.id, '/prepare', {});
  assert.deepEqual(again.data, found.data); assert.equal(detections, before + 1);
  const stored = (await db.query('SELECT payload FROM file_actions WHERE call_id=$1', [source.id])).rows;
  assert.ok(stored.every(r => r.payload.startsWith('dmt1.') && !r.payload.includes('price list')));
  const whatsapp = found.data.actions[1];
  assert.equal((await request(source.id, `/${whatsapp.id}/options`)).status, 409);
});
test('review is required, stale approval fails, duplicate sends return the receipt without resending', async () => {
  const { source, action } = await prepared(), before = sends;
  assert.equal(action.approval_hash, undefined);
  assert.equal((await request(source.id, `/${action.id}/send`, { version: 1 })).status, 409);
  const sent = await request(source.id, `/${action.id}/send`, { version: action.version });
  assert.equal(sent.data.action.status, 'sent'); assert.equal(sent.data.action.message_id, 123);
  assert.equal((await request(source.id, `/${action.id}/send`, { version: action.version })).data.action.status, 'sent');
  assert.equal(sends, before + 1);
  assert.equal((await request(source.id, `/${action.id}/review`, { version: action.version })).status, 409);
});
test('uncertain send is reconciled read-only and blocks deletion', async () => {
  const { source, action } = await prepared(); remoteState = 'timeout';
  assert.equal((await request(source.id, `/${action.id}/send`, { version: action.version })).data.action.status, 'unknown');
  const before = sends;
  assert.equal((await request(source.id, `/${action.id}/send`, { version: action.version })).data.action.status, 'unknown');
  assert.equal(sends, before);
  await assert.rejects(assertDeletable(db, source), /file sending status/);
  remoteState = 'sent';
  assert.equal((await request(source.id, `/${action.id}/status`, {})).data.action.status, 'sent');
  assert.equal(sends, before);
  await assertDeletable(db, source);
  await db.transaction(tx => scrubCall(tx, source));
  assert.equal((await db.query('SELECT id FROM file_actions WHERE call_id=$1', [source.id])).rows.length, 0);
});
test('concurrent approval claims one send and blocks edits/dismissal while in flight', async () => {
  const { source, action } = await prepared(); const before = sends;
  hold = new Promise(resolve => { release = resolve; });
  const first = request(source.id, `/${action.id}/send`, { version: action.version });
  const deadline = Date.now() + 2000;
  while (sends === before && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(sends, before + 1);
  assert.equal((await request(source.id, `/${action.id}/send`, { version: action.version })).data.action.status, 'sending');
  assert.equal((await request(source.id, `/${action.id}/dismiss`, { version: action.version })).status, 409);
  release(); hold = null; await first; assert.equal(sends, before + 1);
});
test('source edits, dismissal, missing link and changed remote selection cannot send', async () => {
  let f = await prepared(); const before = sends;
  await db.query("UPDATE calls SET transcript='changed' WHERE id=$1", [f.source.id]);
  assert.equal((await request(f.source.id, `/${f.action.id}/send`, { version: f.action.version })).status, 409);
  f = await prepared();
  assert.equal((await request(f.source.id, `/${f.action.id}/dismiss`, { version: f.action.version })).status, 200);
  assert.equal((await request(f.source.id, `/${f.action.id}/send`, { version: f.action.version })).status, 409);
  assert.equal(sends, before);
  f = await prepared(); changed = true;
  assert.equal((await request(f.source.id, `/${f.action.id}/send`, { version: f.action.version })).data.action.status, 'failed'); changed = false;
  await db.query('DELETE FROM minime_links WHERE user_id=$1', [users[0].id]);
  assert.equal((await request(f.source.id, `/${f.action.id}/options`)).status, 409);
});
