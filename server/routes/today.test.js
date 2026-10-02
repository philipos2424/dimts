import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const user = (await db.query("INSERT INTO users(phone) VALUES('+15555551301') RETURNING *")).rows[0];
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work),
} });
mock.module('../lib/users.js', { namedExports: {
  resolveUser: async () => user, currentMonth: () => '2026-10',
  HttpError: class extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } },
} });
const { callsRouter } = await import('./calls.js');
const { recordingQualityError } = await import('../lib/recording-quality.js');
const app = express(); app.use(express.json()); app.use('/calls', callsRouter);
const server = app.listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

const contact = (await db.query("INSERT INTO contacts(user_id,phone,display_name) VALUES($1,'+15555551399','Abebe') RETURNING id", [user.id])).rows[0].id;
async function seed(fields) {
  const columns = ['user_id', 'user_phone', 'destination', 'contact_id', 'duration_sec', ...Object.keys(fields)];
  const values = [user.id, '+1', '+15555551399', contact, 60, ...Object.values(fields).map(v => (v && typeof v === 'object' ? JSON.stringify(v) : v))];
  return (await db.query(`INSERT INTO calls(${columns.join(',')}) VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, values)).rows[0].id;
}
const agreement = (subject, value) => ({ kind: 'price', subject, value, said_by: 'Caller', quote: 'q', line: 1, start: 2 });
const quality = status => recordingQualityError({ audio_quality: { status } });

test('each call card says whether both voices were captured', async () => {
  const ids = {
    both: await seed({ status: 'ready', recording_url: 'r' }),
    pending: await seed({ status: 'processing', recording_url: 'r' }),
    no_audio: await seed({ status: 'failed', recording_url: 'r', error: quality('silent') }),
    one_voice: await seed({ status: 'failed', recording_url: 'r', error: quality('missing_channel_signal') }),
    one_channel: await seed({ status: 'failed', recording_url: 'r', error: quality('single_channel') }),
    unknown: await seed({ status: 'failed', recording_url: 'r', error: 'AI processing was interrupted.' }),
    none: await seed({ status: 'failed', error: 'Call no-answer' }),
  };
  const { calls } = await (await fetch(origin + '/calls')).json();
  const capture = id => calls.find(c => c.id === id).capture;
  assert.equal(capture(ids.both), 'both');
  assert.equal(capture(ids.pending), 'pending');
  assert.equal(capture(ids.no_audio), 'no_audio');
  assert.equal(capture(ids.one_voice), 'one_voice');
  assert.equal(capture(ids.one_channel), 'one_voice');
  assert.equal(capture(ids.unknown), 'unknown');
  assert.equal(capture(ids.none), 'none');
});

test('cards carry the first agreements, conflicts and one next step, preferring a pending proposal', async () => {
  const id = await seed({ status: 'ready', recording_url: 'r', next_moves: ['Send the price list'],
    agreements: [agreement('a', '1'), agreement('b', '2'), agreement('c', '3'), agreement('d', '4')],
    conflicts: [{ new_index: 0, previous_call_id: 'x', previous_index: 0, note: 'n' }],
    followups: { email: null, meeting: { title: 'Delivery - Amax', status: 'pending' } } });
  const plain = await seed({ status: 'ready', recording_url: 'r', next_moves: ['Call back'], agreements: null });
  const rejected = await seed({ status: 'ready', recording_url: 'r', next_moves: [],
    followups: { email: { subject: 'Recap', status: 'rejected' }, meeting: null } });
  const { calls } = await (await fetch(origin + '/calls')).json();
  const card = calls.find(c => c.id === id);
  assert.deepEqual(card.agreements.map(a => a.subject), ['a', 'b', 'c']);
  assert.equal(card.conflict_count, 1);
  assert.deepEqual(card.next_step, { kind: 'meeting', text: 'Delivery - Amax' });
  assert.equal(card.contact_id, contact);
  assert.deepEqual(calls.find(c => c.id === plain).next_step, { kind: 'move', text: 'Call back' });
  assert.deepEqual(calls.find(c => c.id === plain).agreements, []);
  assert.equal(calls.find(c => c.id === rejected).next_step, null);
});

test('call detail includes agreements, conflicts and the contact id', async () => {
  const id = await seed({ status: 'ready', recording_url: 'r', agreements: [agreement('unit price', '450 birr')],
    conflicts: [{ new_index: 0, previous_call_id: 'x', previous_index: 0, note: 'n' }] });
  const call = await (await fetch(`${origin}/calls/${id}`)).json();
  assert.deepEqual(call.agreements.map(a => a.value), ['450 birr']);
  assert.equal(call.conflicts.length, 1);
  assert.equal(call.contact_id, contact);
});
