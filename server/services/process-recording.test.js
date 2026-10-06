import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let call;
let identity;
let identifyThrows = false;
const adopted = [];
const touched = [];
const transcriptions = [];
const updates = [];
let claimed = false;

mock.module('../db/pool.js', {
  namedExports: {
    query: async (sql, params) => { updates.push({ sql, params }); return { rows: [{ id: call.id }] }; },
    queryOne: async (sql) => {
      if (!sql.includes('WITH claimed')) return { id: call.id };
      if (claimed) return undefined;
      claimed = true;
      return call;
    },
    getPool: () => ({}),
  },
});

mock.module('./originate.js', {
  namedExports: {
    fetchRecording: async () => ({ ok: true, blob: async () => new Blob(['x']) }),
    isE164: () => true,
  },
});

mock.module('./transcribe.js', {
  namedExports: {
    transcribe: async (_audio, options) => { transcriptions.push(options); return ({
      text: 'Caller: hi this is Phili from Amax\nUser: hello',
      language: 'eng',
      languageProbability: 0.99,
      raw: {},
    }); },
  },
});

mock.module('./summarize.js', {
  namedExports: {
    summarize: async () => ({
      summary: 'Pricing discussion.',
      next_moves: ['Send pricing'],
      action_items: [],
      key_points: [],
    }),
  },
});

mock.module('./identify.js', {
  namedExports: {
    identifyCaller: async () => {
      if (identifyThrows) throw new Error('openai is down');
      return identity;
    },
  },
});

mock.module('../db/contacts.js', {
  namedExports: {
    adoptExtractedName: async (id, candidate) => adopted.push({ id, candidate }),
    touchLastCall: async (id) => touched.push(id),
    findOrCreateContact: async () => ({ id: 'c1' }),
  },
});

const { processRecording } = await import('./process-recording.js');

test.beforeEach(() => {
  call = {
    id: 'call-1',
    direction: 'outbound',
    recording_url: 'https://api.twilio.com/x/Recordings/RE1',
    contact_id: 'c1',
    contact_display_name: null,
    contact_name_source: 'extracted',
    contact_name_confidence: null,
  };
  identity = { name: 'Phili', company: 'Amax', confidence: 0.92 };
  identifyThrows = false;
  adopted.length = 0;
  touched.length = 0;
  transcriptions.length = 0;
  updates.length = 0;
  claimed = false;
});

test('names the contact from a confident identification', async () => {
  await processRecording('call-1');

  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].id, 'c1');
  assert.equal(adopted[0].candidate.name, 'Phili');
  assert.deepEqual(touched, ['c1']);
});

test('does not overwrite a name the user set', async () => {
  call.contact_display_name = 'Phili (procurement)';
  call.contact_name_source = 'user';

  await processRecording('call-1');

  assert.equal(adopted.length, 0);
  assert.deepEqual(touched, ['c1'], 'still records that we spoke');
});

test('skips naming below the confidence floor', async () => {
  identity = { name: 'Maybe Phil', company: null, confidence: 0.4 };
  await processRecording('call-1');
  assert.equal(adopted.length, 0);
});

test('completes the call even when identification fails', async () => {
  identifyThrows = true;
  await assert.doesNotReject(() => processRecording('call-1'));
  assert.equal(adopted.length, 0);
});

test('skips naming when the call has no contact', async () => {
  call.contact_id = null;
  await processRecording('call-1');
  assert.equal(adopted.length, 0);
  assert.equal(touched.length, 0);
});

test('only one concurrent worker transcribes a recording', async () => {
  await Promise.all([processRecording('call-1'), processRecording('call-1')]);
  assert.equal(transcriptions.length, 1);
  assert.equal(adopted.length, 1);
});

test('passes incoming direction and saves language with the notes', async () => {
  call.direction = 'inbound';
  await processRecording('call-1');
  assert.equal(transcriptions[0].direction, 'inbound');
  const saved = updates.find((update) => update.sql.includes('transcript = $2'));
  assert.equal(saved.params[7], 'eng');
  assert.equal(saved.params[8], 0.99);
  assert.match(saved.sql, /processing_token = \$10/);
});

test('interrupted processing releases its lease and keeps a recoverable error', async () => {
  await assert.rejects(processRecording('call-1', { signal: AbortSignal.abort() }));
  assert.equal(transcriptions.length, 0);
  assert.equal(adopted.length, 0);
  const failed = updates.find(update => update.sql.includes("status = 'failed'"));
  assert.match(failed.params[1], /saved recording is retained; retry processing/);
  assert.match(failed.sql, /processing_token = NULL/);
  assert.match(failed.sql, /processing_token = \$3/);
  assert.doesNotMatch(failed.sql, /recording_url\s*=/);
});

test('with encryption keys set, the transcript, raw response and summary are stored sealed for the owner', async () => {
  const { randomBytes } = await import('node:crypto');
  const { openValue } = await import('../lib/field-crypto.js');
  process.env.DATA_ENCRYPTION_KEYS = `t1:${randomBytes(32).toString('base64')}`;
  try {
    call = { ...call, id: '0b3f2b6e-1111-4111-8111-111111111111', user_id: '0b3f2b6e-2222-4222-8222-222222222222' };
    await processRecording(call.id);
    const final = updates.find(u => /status = 'ready'/.test(u.sql));
    const [, transcript, raw, summary] = final.params;
    assert.ok(transcript.startsWith('dmt1.') && !transcript.includes('Phili'));
    assert.equal(openValue(transcript), 'Caller: hi this is Phili from Amax\nUser: hello');
    assert.deepEqual(openValue(JSON.parse(raw)), {});
    assert.equal(openValue(summary), 'Pricing discussion.');
    assert.ok(transcript.includes(call.user_id) && transcript.includes(call.id), 'bound to this owner and call');
  } finally { delete process.env.DATA_ENCRYPTION_KEYS; }
});
