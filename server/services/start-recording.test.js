import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
process.env.PUBLIC_BASE_URL = 'https://example.test';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'test-token';
let received;
mock.module('twilio', { defaultExport: (_sid, _token, opts) => {
  assert.equal(opts.timeout, 5000); assert.equal(opts.autoRetry, false);
  return { calls: sid => ({ recordings: { create: async options => { received = { sid, options }; return { sid: 'RE' + 'a'.repeat(32) }; } } }) };
} });
const { startCallRecording } = await import('./start-recording.js');
test('records the agreed parent call in dual channels with a completion callback', async () => {
  const call = { id: 'call', twilio_call_sid: 'CA' + 'b'.repeat(32) };
  assert.equal(await startCallRecording(call), 'RE' + 'a'.repeat(32));
  assert.equal(received.sid, call.twilio_call_sid);
  assert.equal(received.options.recordingChannels, 'dual'); assert.equal(received.options.recordingTrack, 'both');
  assert.equal(received.options.recordingStatusCallback, 'https://example.test/webhooks/recording-ready?callId=call');
  assert.deepEqual(received.options.recordingStatusCallbackEvent, ['completed']);
  await assert.rejects(startCallRecording({ id: 'other', twilio_call_sid: 'invalid' }), { status: 400 });
});
