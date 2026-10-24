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
let errorAt;
let summaryExtra;
const failures = [];
mock.module('../lib/sentry.js', { namedExports: {
  captureCallFailure: (error, metadata) => failures.push({ error, metadata }),
}});

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
    fetchRecording: async () => { if (errorAt === 'recording_fetch') throw new Error('PRIVATE'); return { ok: true, blob: async () => new Blob(['x']) }; },
    isE164: () => true,
  },
});

mock.module('./transcribe.js', {
  namedExports: {
    transcribe: async (_audio, options) => { transcriptions.push(options); if (errorAt === 'transcription') throw new Error('PRIVATE'); return ({
      text: 'Caller: hi this is Phili from Amax\nUser: hello',
      language: 'eng',
      languageProbability: 0.99,
      raw: {},
    }); },
  },
});

mock.module('./summarize.js', {
  namedExports: {
    summarize: async () => { if (errorAt === 'summary') throw new Error('PRIVATE'); return ({
      summary: 'Pricing discussion.',
      next_moves: ['Send pricing'],
      action_items: [],
      key_points: [],
      ...summaryExtra,
    }); },
  },
});

mock.module('./identify.js', {
  namedExports: {
    identifyCaller: async () => {
      identifyCalls += 1;
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

const events = [];
mock.module('../lib/analytics.js', { namedExports: {
  capture: async (userId, event, properties) => { events.push({ userId, event, properties }); return true; },
}});

let identifyCalls = 0;
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
  errorAt = undefined;
  failures.length = 0;
  identifyThrows = false;
  identifyCalls = 0;
  adopted.length = 0;
  touched.length = 0;
  transcriptions.length = 0;
  updates.length = 0;
  events.length = 0;
  claimed = false;
});

test('notes_ready reports the wait after hang-up and per-stage timings, never content', async () => {
  call.user_id = 'u1';
  call.completed_at = new Date(Date.now() - 30_000);
  await processRecording('call-1');
  const ready = events.find(e => e.event === 'notes_ready');
  assert.ok(ready, 'notes_ready was sent');
  const p = ready.properties;
  assert.ok(p.seconds_after_hangup >= 30 && p.seconds_after_hangup < 60);
  assert.ok(p.queue_seconds >= 30 && p.queue_seconds < 60);
  for (const key of ['processing_seconds', 'transcribe_seconds', 'summary_seconds']) assert.equal(typeof p[key], 'number', key);
  assert.equal(p.direction, 'outbound');
  assert.equal(p.voicemail, false);
  assert.deepEqual(Object.keys(p).sort(), ['direction', 'processing_seconds', 'queue_seconds',
    'seconds_after_hangup', 'summary_seconds', 'transcribe_seconds', 'voicemail']);
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
  assert.equal(identifyCalls, 0, 'no model call for a name that cannot change');
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

test('with encryption keys set, next steps, action items, key points and agreements are stored sealed too', async () => {
  const { randomBytes } = await import('node:crypto');
  const { openValue } = await import('../lib/field-crypto.js');
  process.env.DATA_ENCRYPTION_KEYS = `t1:${randomBytes(32).toString('base64')}`;
  summaryExtra = {
    next_moves: ['Send pricing'], key_points: ['Pricing was discussed'],
    action_items: [{ task: 'Email the quote', owner: 'User', due: null }],
    agreements: [{ kind: 'price', subject: 'Cement', value: '40,000 birr', said_by: 'User', source_lines: [2] }],
  };
  try {
    call = { ...call, id: '0b3f2b6e-1111-4111-8111-111111111111', user_id: '0b3f2b6e-2222-4222-8222-222222222222' };
    await processRecording(call.id);
    const { params } = updates.find(u => /status = 'ready'/.test(u.sql));
    const [nextMoves, actionItems, keyPoints] = [params[4], params[5], params[6]].map(p => JSON.parse(p));
    const agreements = JSON.parse(params[10]);
    for (const sealed of [nextMoves, actionItems, keyPoints, agreements]) {
      assert.ok(typeof sealed === 'string' && sealed.startsWith('dmt1.'), 'stored as a sealed string');
      assert.ok(!/Send pricing|Email the quote|Pricing was|Cement|hello/.test(sealed));
      assert.ok(sealed.includes(call.user_id) && sealed.includes(call.id), 'bound to this owner and call');
    }
    assert.deepEqual(openValue(nextMoves), ['Send pricing']);
    assert.deepEqual(openValue(actionItems), [{ task: 'Email the quote', owner: 'User', due: null }]);
    assert.deepEqual(openValue(keyPoints), ['Pricing was discussed']);
    const [agreement] = openValue(agreements);
    assert.deepEqual([agreement.subject, agreement.quote], ['Cement', 'User: hello']);
  } finally { delete process.env.DATA_ENCRYPTION_KEYS; summaryExtra = undefined; }
});

for (const stage of ['recording_fetch', 'transcription', 'summary']) {
  test(stage + ' failure reports call metadata and still persists failure/rethrows', async () => {
    errorAt = stage;
    await assert.rejects(processRecording(call.id), /PRIVATE/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].metadata.callId, call.id);
    assert.equal(failures[0].metadata.stage, stage);
    assert.ok(updates.some(update => update.sql.includes("status = 'failed'")));
  });
}
test('successful processing emits no failure event', async () => {
  await processRecording(call.id);
  assert.equal(failures.length, 0);
});
