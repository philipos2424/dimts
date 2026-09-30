import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_BASE_URL = 'https://agent.example.com';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.SKIP_TWILIO_SIGNATURE_CHECK = 'true';

let user;
let contact;
let failContactLookup = false;
const inserted = [];

mock.module('../db/agent-numbers.js', {
  namedExports: { findUserByAgentNumber: async () => user },
});

mock.module('../db/contacts.js', {
  namedExports: {
    findOrCreateContact: async () => {
      if (failContactLookup) throw new Error('database is down');
      return contact;
    },
    adoptExtractedName: async () => {},
    touchLastCall: async () => {},
  },
});

mock.module('../db/pool.js', {
  namedExports: {
    query: async () => ({ rows: [] }),
    queryOne: async (text, params) => {
      if (text.includes('INSERT INTO calls')) {
        inserted.push(params);
        return { id: 'call-1' };
      }
      return undefined;
    },
    getPool: () => ({}),
  },
});

const { createApp } = await import('../create-app.js');
const app = createApp();

async function incoming(body) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/twiml/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return { status: res.status, xml: await res.text() };
  } finally {
    server.close();
  }
}

const CALL = { From: '+14155552671', To: '+14155551111', CallSid: 'CA_IN_1' };

test.beforeEach(() => {
  user = { id: 'u1', phone: '+14155550000', agent_number: '+14155551111' };
  contact = { id: 'c1', phone: '+14155552671', display_name: null };
  failContactLookup = false;
  inserted.length = 0;
  process.env.ANNOUNCE_RECORDING = 'true';
});

test('asks for agreement before dialling or recording', async () => {
  const { xml } = await incoming(CALL);

  assert.match(xml, /<Gather/);
  assert.match(xml, /accept\?callId=call-1/);
  assert.doesNotMatch(xml, /<Dial|record=/);
});

test('announces recording to the caller before connecting', async () => {
  const { xml } = await incoming(CALL);

  const sayAt = xml.indexOf('<Say');
  assert.ok(sayAt > -1, 'expected a consent announcement');
  assert.doesNotMatch(xml, /<Dial/);
  assert.match(xml, /will be recorded/i);
});

test('cannot disable consent with the legacy announcement flag', async () => {
  process.env.ANNOUNCE_RECORDING = 'false';
  const { xml } = await incoming(CALL);
  assert.match(xml, /<Gather/);
});

test('records the call as inbound and links the contact', async () => {
  await incoming(CALL);

  assert.equal(inserted.length, 1);
  const [userId, userPhone, destination, sid, contactId] = inserted[0];
  assert.equal(userId, 'u1');
  assert.equal(userPhone, '+14155550000');
  assert.equal(destination, '+14155552671', 'destination is the caller');
  assert.equal(sid, 'CA_IN_1');
  assert.equal(contactId, 'c1');
});

test('rejects a call to a number nobody has claimed', async () => {
  user = undefined;
  const { xml } = await incoming(CALL);

  assert.doesNotMatch(xml, /<Dial/);
  assert.match(xml, /<Hangup\/>/);
});

test('still offers connection when the contact lookup fails', async () => {
  failContactLookup = true;
  const { xml } = await incoming(CALL);

  // The AI layer must never be able to break a phone call.
  assert.match(xml, /accept\?callId=call-1/);
});
