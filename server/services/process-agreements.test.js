import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
} });
const transcript = 'Caller: Hello.\nUser: 450 birr per unit is fine.';
const raw = { transcripts: [
  { text: 'Hello.', words: [{ text: 'Hello.', start: 0.5, end: 1, type: 'word' }] },
  { text: '450 birr per unit is fine.', words: [{ text: '450', start: 3, end: 3.2, type: 'word' }, { text: 'birr', start: 3.3, end: 3.5, type: 'word' },
    { text: 'per', start: 3.6, end: 3.7, type: 'word' }, { text: 'unit', start: 3.8, end: 4, type: 'word' },
    { text: 'is', start: 4.1, end: 4.2, type: 'word' }, { text: 'fine.', start: 4.3, end: 4.6, type: 'word' }] },
] };
let summarizeOptions;
mock.module('./originate.js', { namedExports: { isE164: () => true, fetchRecording: async () => new Response(new Uint8Array([1])) } });
mock.module('./archive-audio.js', { namedExports: { archiveAudio: async () => 'skipped', removeArchivedFromProvider: async () => 'skipped' } });
mock.module('./audio-store.js', { namedExports: { getAudio: async () => new Response(new Uint8Array([1])) } });
mock.module('./transcribe.js', { namedExports: { transcribe: async () => ({ text: transcript, raw, language: 'eng', languageProbability: 1 }) } });
mock.module('./summarize.js', { namedExports: { summarize: async (_text, options) => { summarizeOptions = options; return {
  summary: 'Agreed a price.', next_moves: [], action_items: [], key_points: [],
  agreements: [{ kind: 'price', subject: 'unit price', value: '450 birr', said_by: 'User', source_lines: [2] },
    { kind: 'price', subject: 'made up', value: '1 birr', said_by: 'Caller', source_lines: [7] }],
}; } } });
mock.module('./identify.js', { namedExports: { identifyCaller: async () => ({ name: null, confidence: 0 }) } });
const { processRecording } = await import('./process-recording.js');
test.after(() => db.close());

test('processing saves verified agreements with their spoken moment, written in the owner\'s language', async () => {
  const user = (await db.query("INSERT INTO users(phone,language) VALUES('+15555550801','am') RETURNING id")).rows[0];
  const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,direction,recording_url,duration_sec)
    VALUES($1,'+1','+2','processing','inbound','https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1',60) RETURNING id`, [user.id])).rows[0];
  await processRecording(call.id);
  assert.equal(summarizeOptions.language, 'am');
  const saved = (await db.query('SELECT status,agreements FROM calls WHERE id=$1', [call.id])).rows[0];
  assert.equal(saved.status, 'ready');
  assert.deepEqual(saved.agreements, [{ kind: 'price', subject: 'unit price', value: '450 birr', said_by: 'User',
    quote: 'User: 450 birr per unit is fine.', line: 2, start: 3 }]);
});
