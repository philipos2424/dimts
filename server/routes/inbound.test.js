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
  checkPushReceipts: async () => {}, validPushToken: () => true, sendPrivacyRequestNotification: async () => {},
} });
mock.module('../db/reserve-call.js', { namedExports: {
  reserveCall: async (owner, caller, record, key, options) => {
    if (failReservation === 'released') throw Object.assign(new Error('released'), { code: 'number_not_in_service' });
    if (failReservation === 'out_of_credit' && !options.voicemailOnly) throw Object.assign(new Error('no credit'), { code: 'credits_required' });
    if (failReservation === true) throw new Error('budget exceeded');
    if (options.voicemailOnly) return { call: { ...reserved, status: 'missed', voicemail: true }, created: true };
    inserted.push([owner.id, owner.phone, caller, options.callSid, options.contactId]);
    return { call: reserved, created: true };
  },
} });

const balanceAlerts = [];
mock.module('../services/billing-alerts.js', { namedExports: {
  sendMissedForBalanceAlert: async id => { balanceAlerts.push(id); return true; },
  sendBalanceAlerts: async () => [],
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

test('the owner sees the real caller number, not the Dimts number', async () => {
  reserved = { ...reserved, destination: CALL.From };
  const { xml } = await incoming(CALL);
  assert.match(xml, /callerId="\+14155552671"/);
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

test('a Gulf caller must press 1 before the owner is rung, and hears no notice-only connection', async () => {
  reserved = { ...reserved, consent_mode: 'all_parties', child_consent_at: null };
  const { xml } = await incoming({ ...CALL, From: '+971501234567' });
  assert.match(xml, /<Gather[^>]*action="https:\/\/agent\.example\.com\/twiml\/accept\?callId=call-1"/);
  assert.match(xml, /only if both people agree/);
  assert.doesNotMatch(xml, /<Dial|Dimts AI\./);
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

test('a release between lookup and reservation returns the neutral disconnected message', async () => {
  failReservation = 'released';
  const { xml } = await incoming(CALL);
  assert.match(xml, /This number is not in service\./);
  assert.match(xml, /<Hangup\/>/);
  assert.doesNotMatch(xml, /<Dial|<Record|<Gather/);
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

test('an owner out of minutes and credits still gets a message, and is told why', async () => {
  failReservation = 'out_of_credit';
  balanceAlerts.length = 0;
  const { xml } = await incoming(CALL);
  assert.match(xml, /This call is recorded and summarized by Dimts AI\./);
  assert.match(xml, /Leave a message after the tone/);
  assert.match(xml, /<Record[^>]*maxLength="120"/);
  assert.doesNotMatch(xml, /<Dial/);
  assert.ok(xml.indexOf('Dimts AI') < xml.indexOf('<Record'), 'notice before recording');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(balanceAlerts, ['u1']);
});

test('without recording consent the out-of-credit caller is turned away, not recorded', async () => {
  failReservation = 'out_of_credit';
  reserved = { ...reserved, record_enabled: false };
  const { xml } = await incoming(CALL);
  assert.match(xml, /cannot connect this call/);
  assert.doesNotMatch(xml, /<Record/);
});
