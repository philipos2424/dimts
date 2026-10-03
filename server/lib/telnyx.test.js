import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.TELNYX_API_KEY = 'KEYtest';
process.env.TELNYX_ACCOUNT_SID = '6a9a7976-012e-45d2-9258-6f5dc68d861e';
process.env.TELNYX_TEXML_APP_ID = '1568109700606592442';
process.env.TELNYX_VERIFY_PROFILE_ID = '4900017a-e6a1-4b8b-8f0c-6d2b4f0e1a2c';
process.env.PUBLIC_BASE_URL = 'https://dimts.example';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

const { isAccountSid, isCallSid, isRecordingSid } = await import('./carrier.js');
const { isValidTelnyxRequest } = await import('./twilio-signature.js');
const { telnyxRest } = await import('./telnyx-rest.js');
const { sendPhoneCode, checkPhoneCode } = await import('../services/verify-phone.js');
const { fetchRecording } = await import('../services/originate.js');
const twilio = (await import('twilio')).default;
const { askRecordingConsent, dialCall, offerVoicemail } = await import('./recording-consent.js');

const CALL_SID = 'v3:9X2vxPDFY2RHSJ1EdMS0RHRksMTg7ldNxdjWbVr9zBjbGjGsSe-aiQ';
const RECORDING_SID = '35094891-3290-4142-b2c2-b2eda57534cf';
let requests = [];
let reply = () => ({ status: 200, body: {} });
const realFetch = globalThis.fetch;
test.beforeEach(() => {
  process.env.CARRIER = 'telnyx';
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const { status, body } = reply(String(url), init);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
});
test.after(() => { globalThis.fetch = realFetch; delete process.env.CARRIER; });

test('identifier formats follow the active carrier', () => {
  assert.equal(isCallSid(CALL_SID), true);
  assert.equal(isRecordingSid(RECORDING_SID), true);
  assert.equal(isAccountSid(process.env.TELNYX_ACCOUNT_SID), true);
  assert.equal(isCallSid('CA' + 'a'.repeat(32)), false);
  process.env.CARRIER = 'twilio';
  assert.equal(isCallSid('CA' + 'a'.repeat(32)), true);
  assert.equal(isCallSid(CALL_SID), false);
});

function signedRequest(body, { timestamp = Math.floor(Date.now() / 1000), key = privateKey } = {}) {
  const raw = Buffer.from(body);
  const signature = sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), key).toString('base64');
  const headers = { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': String(timestamp) };
  return { rawBody: raw, get: name => headers[name.toLowerCase()] };
}

test('Telnyx webhooks are accepted only with a valid, fresh Ed25519 signature over the raw body', () => {
  const body = 'CallSid=v3%3Aabc&CallStatus=completed';
  assert.equal(isValidTelnyxRequest(signedRequest(body)), true);
  const tampered = signedRequest(body); tampered.rawBody = Buffer.from(body.replace('completed', 'failed'));
  assert.equal(isValidTelnyxRequest(tampered), false);
  assert.equal(isValidTelnyxRequest(signedRequest(body, { timestamp: Math.floor(Date.now() / 1000) - 600 })), false, 'replayed');
  assert.equal(isValidTelnyxRequest(signedRequest(body, { key: generateKeyPairSync('ed25519').privateKey })), false, 'wrong key');
  assert.equal(isValidTelnyxRequest({ rawBody: Buffer.from(body), get: () => undefined }), false, 'unsigned');
});

test('outbound calls go through the TeXML application with REST parameter names', async () => {
  reply = () => ({ status: 200, body: { from: '+1', to: '+2', status: 'queued' } });
  const created = await telnyxRest().calls.create({ to: '+15555550101', from: '+15555550100', url: 'https://dimts.example/twiml/bridge',
    urlMethod: 'POST', statusCallbackEvent: ['initiated', 'completed'] });
  const [req] = requests;
  assert.equal(req.url, `https://api.telnyx.com/v2/texml/Accounts/${process.env.TELNYX_ACCOUNT_SID}/Calls`);
  assert.equal(req.headers.Authorization, 'Bearer KEYtest');
  assert.deepEqual(JSON.parse(req.body), { ApplicationSid: process.env.TELNYX_TEXML_APP_ID, To: '+15555550101', From: '+15555550100',
    Url: 'https://dimts.example/twiml/bridge', UrlMethod: 'POST', StatusCallbackEvent: 'initiated completed' });
  assert.equal(created.sid, null, 'no SID in the documented response; the first webhook supplies it');
});

test('recording resources come back in the shape the services read, and errors keep their status', async () => {
  reply = () => ({ status: 200, body: { account_sid: process.env.TELNYX_ACCOUNT_SID, call_sid: CALL_SID, sid: RECORDING_SID, status: 'completed', channels: 2 } });
  const recording = await telnyxRest().recordings(RECORDING_SID).fetch();
  assert.equal(recording.accountSid, process.env.TELNYX_ACCOUNT_SID);
  assert.equal(recording.callSid, CALL_SID);
  assert.match(requests[0].url, /\/Recordings\/35094891-3290-4142-b2c2-b2eda57534cf\.json$/);
  reply = () => ({ status: 404, body: { errors: [{ code: '10005', detail: 'Not found' }] } });
  await assert.rejects(telnyxRest().recordings(RECORDING_SID).fetch(), err => err.status === 404);
});

test('sign-in codes use Telnyx Verify by SMS or voice call, and only "accepted" passes', async () => {
  reply = () => ({ status: 200, body: { data: { id: 'x' } } });
  await sendPhoneCode('+251911143200', 'call');
  await sendPhoneCode('+14155552671');
  assert.match(requests[0].url, /\/v2\/verifications\/call$/);
  assert.match(requests[1].url, /\/v2\/verifications\/sms$/);
  assert.deepEqual(JSON.parse(requests[0].body), { phone_number: '+251911143200', verify_profile_id: process.env.TELNYX_VERIFY_PROFILE_ID });
  reply = () => ({ status: 200, body: { data: { phone_number: '+14155552671', response_code: 'accepted' } } });
  assert.equal(await checkPhoneCode('+14155552671', '12345'), true);
  assert.match(requests[2].url, /\/verifications\/by_phone_number\/%2B14155552671\/actions\/verify$/);
  reply = () => ({ status: 200, body: { data: { response_code: 'rejected' } } });
  assert.equal(await checkPhoneCode('+14155552671', '00000'), false);
  reply = () => ({ status: 404, body: { errors: [{ detail: 'no verification' }] } });
  assert.equal(await checkPhoneCode('+14155552671', '00000'), false);
});

test('recordings download from a fresh link owned by this account', async () => {
  reply = url => url.includes('/Recordings/')
    ? { status: 200, body: { account_sid: process.env.TELNYX_ACCOUNT_SID, sid: RECORDING_SID, media_url: 'https://s3.example.com/rec.mp3?sig=1' } }
    : { status: 200, body: {} };
  await fetchRecording('https://stale.example.com/old.mp3', { recordingSid: RECORDING_SID, range: 'bytes=0-99' });
  assert.equal(requests[1].url, 'https://s3.example.com/rec.mp3?sig=1');
  assert.equal(requests[1].headers.Range, 'bytes=0-99');
  assert.equal(requests[1].headers.Authorization, undefined, 'signed storage links get no API key');
  reply = () => ({ status: 200, body: { account_sid: '11111111-1111-1111-1111-111111111111', sid: RECORDING_SID, media_url: 'https://s3.example.com/x' } });
  await assert.rejects(fetchRecording('https://x.example', { recordingSid: RECORDING_SID }), /owner mismatch/);
});

const xml = build => { const t = new twilio.twiml.VoiceResponse(); build(t); return t.toString(); };
const base = { id: 'call-1', direction: 'outbound', destination: '+15555550101', user_phone: '+15555550100', agent_number: '+15555550199', max_duration_sec: 600 };

test('on Telnyx, notice calls record through Dial and consent prompts never hang up on silence', () => {
  const notice = xml(t => dialCall(t, { ...base, record_enabled: true, consent_mode: 'notice' }));
  assert.match(notice, /record="record-from-answer-dual"/);
  assert.match(notice, /recordingStatusCallback="https:\/\/dimts\.example\/webhooks\/recording-ready\?callId=call-1"/);
  const allParties = xml(t => dialCall(t, { ...base, record_enabled: true, consent_mode: 'all_parties' }));
  assert.match(allParties, /record="do-not-record"/, 'explicit consent still starts recording only after both agree');
  const prompt = xml(t => askRecordingConsent(t, 'https://dimts.example/twiml/accept?callId=call-1'));
  assert.match(prompt, /<Redirect method="POST">https:\/\/dimts\.example\/twiml\/accept\?callId=call-1<\/Redirect>/);
  assert.doesNotMatch(prompt, /<Hangup/);
  assert.match(xml(t => offerVoicemail(t, base)), /<Record[^>]*channels="single"/);
});

test('on Twilio, the markup is unchanged', () => {
  process.env.CARRIER = 'twilio';
  process.env.TWILIO_NUMBER = '+15555550999';
  assert.match(xml(t => dialCall(t, { ...base, record_enabled: true, consent_mode: 'notice' })), /record="do-not-record"/);
  assert.match(xml(t => askRecordingConsent(t, 'https://dimts.example/a')), /<Hangup\/>/);
  assert.doesNotMatch(xml(t => offerVoicemail(t, base)), /channels=/);
});
