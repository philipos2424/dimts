import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_BASE_URL = 'https://dimts.ngrok-free.app';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.SKIP_TWILIO_SIGNATURE_CHECK = 'true';

/**
 * In-memory stand-in for the pg pool. Records every statement so tests can
 * assert on *which* writes happened, which is the point for billing.
 */
const db = {
  calls: [],
  statements: [],
  reset() {
    this.calls = [];
    this.statements = [];
  },
};

function run(text, params = []) {
  db.statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
  const sql = text.replace(/\s+/g, ' ');

  if (sql.includes('FROM calls WHERE id = $1')) {
    return { rows: db.calls.filter((c) => c.id === params[0]) };
  }
  if (sql.includes('FROM calls WHERE twilio_call_sid = $1')) {
    return { rows: db.calls.filter((c) => c.twilio_call_sid === params[0]) };
  }
  if (sql.includes('UPDATE calls') && sql.includes('duration_sec = $2')) {
    const call = db.calls.find((c) => c.id === params[0]);
    // Mirrors the "AND duration_sec IS NULL" guard in the real statement.
    if (!call || call.duration_sec !== null) return { rows: [] };
    call.duration_sec = params[1];
    call.status = params[2] ? 'processing' : params[4];
    return { rows: [{ id: call.id, user_id: call.user_id }] };
  }
  if (sql.includes('UPDATE calls')) {
    const call = db.calls.find((c) => c.id === params[0]);
    if (call && sql.includes('recording_url = $2')) {
      call.recording_url = params[1];
      call.status = 'processing';
    } else if (call && params[1]) {
      call.status = String(params[1]).startsWith('Call ') ? 'failed' : params[1];
    }
    return { rows: [] };
  }
  return { rows: [] };
}

mock.module('../db/pool.js', {
  namedExports: {
    query: async (t, p) => run(t, p),
    queryOne: async (t, p) => run(t, p).rows[0],
    getPool: () => ({}),
  },
});

// Never let a test reach the real pipeline (or a real API key).
mock.module('../services/process-recording.js', {
  namedExports: { processRecording: async () => {} },
});

const { createApp } = await import('../app.js');
const app = createApp();

function seedCall(overrides = {}) {
  const call = {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: 'user-1',
    twilio_call_sid: 'CA_PARENT',
    status: 'ringing',
    direction: 'outbound',
    duration_sec: null,
    recording_url: null,
    ...overrides,
  };
  db.calls.push(call);
  return call;
}

async function post(path, body) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } finally {
    server.close();
  }
}

const usageWrites = () =>
  db.statements.filter((s) => s.text.includes('INSERT INTO usage_minutes'));

test.beforeEach(() => db.reset());

test('resolves the call from the callId query param', async () => {
  const call = seedCall();
  const res = await post(`/twiml/dial-done?callId=${call.id}`, {
    DialCallStatus: 'completed',
    DialCallDuration: '120',
    CallSid: 'CA_UNRELATED',
  });

  assert.equal(res.status, 200);
  assert.equal(call.duration_sec, 120);
  assert.equal(call.status, 'processing');
});

test('falls back to CallSid when callId is absent', async () => {
  const call = seedCall();
  await post('/twiml/dial-done', {
    DialCallStatus: 'completed',
    DialCallDuration: '60',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.duration_sec, 60);
});

test('ignores a webhook matching neither callId nor CallSid', async () => {
  seedCall();
  const res = await post('/twiml/dial-done?callId=does-not-exist', {
    DialCallStatus: 'completed',
    DialCallDuration: '60',
    CallSid: 'CA_NOPE',
  });

  assert.equal(res.status, 200);
  assert.equal(db.calls[0].duration_sec, null);
  assert.equal(usageWrites().length, 0);
});

test('bills a completed call exactly once even if Twilio retries', async () => {
  const call = seedCall();
  const payload = {
    DialCallStatus: 'completed',
    DialCallDuration: '180',
    CallSid: 'CA_PARENT',
  };

  await post(`/twiml/dial-done?callId=${call.id}`, payload);
  await post(`/twiml/dial-done?callId=${call.id}`, payload);

  assert.equal(usageWrites().length, 1, 'duplicate webhook must not double-bill');
  assert.equal(usageWrites()[0].params[2], 3); // 180s -> 3 minutes
});

test('does not bill an unanswered call', async () => {
  const call = seedCall();
  await post(`/twiml/dial-done?callId=${call.id}`, {
    DialCallStatus: 'no-answer',
    DialCallDuration: '0',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.status, 'failed');
  assert.equal(usageWrites().length, 0);
});

test('recording-ready stores the URL and kicks off processing', async () => {
  const call = seedCall({ status: 'processing' });
  const res = await post(`/webhooks/recording-ready?callId=${call.id}`, {
    RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1',
    RecordingStatus: 'completed',
    CallSid: 'CA_PARENT',
  });

  assert.equal(res.status, 204);
  assert.match(call.recording_url, /Recordings\/RE1$/);
});

test('recording-ready ignores a non-completed status', async () => {
  const call = seedCall({ status: 'processing' });
  await post(`/webhooks/recording-ready?callId=${call.id}`, {
    RecordingUrl: 'https://api.twilio.com/x/Recordings/RE2',
    RecordingStatus: 'in-progress',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.recording_url, null);
});

test('bridge TwiML dials the destination with dual-channel recording', async () => {
  const res = await post('/twiml/bridge?dest=%2B251911234567&callId=abc', {});
  const xml = await res.text();

  assert.match(xml, /record="record-from-answer-dual"/);
  assert.match(xml, /<Number>\+251911234567<\/Number>/);
  assert.match(xml, /recording-ready\?callId=abc/);
  assert.match(xml, /dial-done\?callId=abc/);
});

test('bridge hangs up rather than dialling when no destination is given', async () => {
  const res = await post('/twiml/bridge?callId=abc', {});
  const xml = await res.text();

  assert.doesNotMatch(xml, /<Dial/);
  assert.match(xml, /<Hangup\/>/);
});

test('an unmatched path is a 404, not a signature rejection', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  } finally {
    server.close();
  }
});

test('an unanswered inbound call is recorded as missed, not failed', async () => {
  const call = seedCall({ direction: 'inbound' });

  await post(`/twiml/dial-done?callId=${call.id}`, {
    DialCallStatus: 'no-answer',
    DialCallDuration: '0',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.status, 'missed');
  assert.equal(usageWrites().length, 0);
});

test('an answered inbound call still processes and bills normally', async () => {
  const call = seedCall({ direction: 'inbound' });

  await post(`/twiml/dial-done?callId=${call.id}`, {
    DialCallStatus: 'completed',
    DialCallDuration: '120',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.status, 'processing');
  assert.equal(usageWrites().length, 1);
});

test('an unanswered outbound call is still failed', async () => {
  const call = seedCall({ direction: 'outbound' });

  await post(`/twiml/dial-done?callId=${call.id}`, {
    DialCallStatus: 'no-answer',
    DialCallDuration: '0',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.status, 'failed');
});
