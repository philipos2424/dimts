import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_BASE_URL = 'https://agent.example.com';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.SKIP_TWILIO_SIGNATURE_CHECK = 'true';

let user;
let contact;
let failContactLookup = false;
let failReservation = false;
let reserved;
const inserted = [];
const notified = [];
mock.module('../services/notifications.js', { namedExports: {
  sendIncomingNotification: async id => { notified.push(id); },
  checkPushReceipts: async () => {}, validPushToken: () => true,
} });
mock.module('../db/reserve-call.js', { namedExports: {
  reserveCall: async (owner, caller, record, key, options) => {
    if (failReservation) throw new Error('budget exceeded');
    inserted.push([owner.id, owner.phone, caller, options.callSid, options.contactId]);
    return { call: reserved, created: true };
  },
} });

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
      if (text.includes('other_party_notice_issued_at')) return { ...reserved, other_party_notice_issued_at:new Date() };
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
  failReservation = false;
  reserved = { id:'call-1',status:'ringing',direction:'inbound',user_phone:user.phone,record_enabled:true,
    consent_mode:'notice',child_consent_at:new Date(),agent_number:user.agent_number };
  inserted.length = 0;
  notified.length = 0;
  process.env.ANNOUNCE_RECORDING = 'true';
});

test('the caller hears the Dimts notice and is connected to the owner with no key press', async () => {
  const { xml } = await incoming(CALL);
  assert.doesNotMatch(xml, /<Gather|<Hangup/);
  assert.match(xml, /This call is recorded and summarized by Dimts AI\./);
  assert.ok(xml.indexOf('<Say') < xml.indexOf('<Dial'), 'notice before dialling');
  assert.match(xml, /record="do-not-record"/);
  assert.match(xml, /party-consent\?callId=call-1/);
  assert.match(xml, new RegExp(user.phone.slice(1)));
  assert.deepEqual(notified, ['call-1']);
});

test('the legacy announcement flag cannot switch the notice off', async () => {
  process.env.ANNOUNCE_RECORDING = 'false';
  const { xml } = await incoming(CALL);
  assert.match(xml, /recorded and summarized by Dimts AI/);
});

test('an unrecorded call (owner has not accepted terms) connects without a notice', async () => {
  reserved = { ...reserved, record_enabled: false, child_consent_at: null };
  const { xml } = await incoming(CALL);
  assert.doesNotMatch(xml, /Dimts AI|<Gather|<Hangup/);
  assert.match(xml, /<Dial/);
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
  assert.match(xml, /party-consent\?callId=call-1/);
});

test('cannot bridge when budget reservation fails', async () => {
  failReservation = true;
  const { xml } = await incoming(CALL);
  assert.match(xml, /<Hangup/);
  assert.doesNotMatch(xml, /<Dial|<Gather/);
});
