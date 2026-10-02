import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let call, claimed, twilioFetches, storeReads, archived, removals, transcribed, deferred;
mock.module('../db/pool.js', { namedExports: {
  query: async () => ({ rows: [{ id: call.id }] }),
  queryOne: async sql => {
    if (!sql.includes('WITH claimed')) return { id: call.id };
    if (claimed) return undefined;
    claimed = true; return call;
  },
  getPool: () => ({}),
} });
mock.module('./originate.js', { namedExports: {
  fetchRecording: async () => { twilioFetches++; return { ok: true, blob: async () => new Blob([new Uint8Array([7, 8, 9])]) }; },
  isE164: () => true,
} });
mock.module('./audio-store.js', { namedExports: {
  getAudio: async key => { storeReads.push(key); return new Response(new Uint8Array([4, 5])); },
} });
mock.module('./archive-audio.js', { namedExports: {
  archiveAudio: async (c, bytes) => { archived.push([c.id, [...bytes]]); return 'stored'; },
  removeArchivedFromProvider: async id => { removals.push(id); return 'removed'; },
} });
mock.module('../lib/defer.js', { namedExports: { defer: (promise, label) => { deferred.push(label); return promise; } } });
mock.module('./transcribe.js', { namedExports: {
  transcribe: async audio => { transcribed.push([...new Uint8Array(await audio.arrayBuffer())]);
    return { text: 'Caller: hi\nUser: hello', language: 'eng', languageProbability: 0.9, raw: {} }; },
} });
mock.module('./summarize.js', { namedExports: { summarize: async () => ({ summary: 's', next_moves: [], action_items: [], key_points: [] }) } });
mock.module('./identify.js', { namedExports: { identifyCaller: async () => ({ name: null, confidence: 0 }) } });
mock.module('../db/contacts.js', { namedExports: { adoptExtractedName: async () => {}, touchLastCall: async () => {}, findOrCreateContact: async () => ({}) } });
const { processRecording } = await import('./process-recording.js');

test.beforeEach(() => {
  call = { id: 'call-1', user_id: 'u1', direction: 'outbound', recording_url: 'https://api.twilio.com/x/Recordings/RE1', contact_id: null };
  claimed = false; twilioFetches = 0; storeReads = []; archived = []; removals = []; transcribed = []; deferred = [];
});

test('a fresh recording is archived before transcription, which uses the same bytes; Twilio removal follows success', async () => {
  await processRecording('call-1');
  assert.equal(twilioFetches, 1);
  assert.deepEqual(archived, [['call-1', [7, 8, 9]]]);
  assert.deepEqual(transcribed, [[7, 8, 9]]);
  await Promise.resolve();
  assert.deepEqual(removals, ['call-1']);
});

test('an archived recording is read from EU storage and never fetched from Twilio again', async () => {
  call.audio_object_key = 'u1/call-1.mp3';
  await processRecording('call-1', { force: true });
  assert.equal(twilioFetches, 0);
  assert.deepEqual(storeReads, ['u1/call-1.mp3']);
  assert.deepEqual(archived, []);
  assert.deepEqual(transcribed, [[4, 5]]);
});
