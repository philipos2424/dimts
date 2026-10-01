import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const account = 'AC' + 'a'.repeat(32), parent = 'CA' + 'b'.repeat(32), sid = 'RE' + 'c'.repeat(32);
process.env.TWILIO_ACCOUNT_SID = account; process.env.TWILIO_AUTH_TOKEN = 'test-token';
let rows = [], error, fetches = 0, lists = 0;
mock.module('twilio', { defaultExport: (_account, _token, options) => {
  assert.equal(options.autoRetry, false); assert.equal(options.timeout, 10_000);
  return {
    recordings: id => ({ fetch: async () => { fetches++; assert.equal(id, sid); if (error) throw error; return rows[0]; } }),
    calls: id => ({ recordings: { list: async options => { lists++; assert.equal(id, parent);
      assert.deepEqual(options, { limit: 2, pageSize: 2 }); if (error) throw error; return rows; } } }),
  };
} });
const { findCompletedRecording } = await import('./find-recording.js');
const valid = () => ({ sid, accountSid: account, callSid: parent, status: 'completed', channels: 2, duration: '60' });
test.afterEach(() => { error = undefined; });

test('known SID is fetched directly; unknown startup searches only its call and constructs its own trusted media URL', async () => {
  rows = [{ ...valid(), uri: 'https://evil.example/do-not-use' }];
  let result = await findCompletedRecording({ twilio_call_sid: parent, recording_sid: sid });
  assert.equal(result.status, 'found'); assert.equal(fetches, 1); assert.equal(lists, 0);
  assert.equal(result.url, `https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${sid}`);
  result = await findCompletedRecording({ twilio_call_sid: parent });
  assert.equal(result.sid, sid); assert.equal(lists, 1);
});

test('missing, unfinished, multiple, empty and single-channel recordings are never silently treated as a complete conversation', async () => {
  for (const [records, expected] of [[[], 'unavailable'], [[valid(), valid()], 'ambiguous'],
    [[{ ...valid(), status: 'processing' }], 'unavailable'], [[{ ...valid(), duration: '0' }], 'unsupported'],
    [[{ ...valid(), channels: 1 }], 'unsupported']]) {
    rows = records; assert.equal((await findCompletedRecording({ twilio_call_sid: parent })).status, expected);
  }
  error = Object.assign(new Error('missing'), { status: 404 });
  assert.equal((await findCompletedRecording({ twilio_call_sid: parent, recording_sid: sid })).status, 'unavailable');
});

test('wrong account, call or SID is rejected and uncertain provider errors are preserved for safe handling', async () => {
  for (const change of [{ accountSid: 'AC' + 'd'.repeat(32) }, { callSid: 'CA' + 'd'.repeat(32) },
    { sid: 'RE' + 'd'.repeat(32) }]) {
    rows = [{ ...valid(), ...change }];
    await assert.rejects(findCompletedRecording({ twilio_call_sid: parent, recording_sid: sid }), /owner mismatch/);
  }
  await assert.rejects(findCompletedRecording({ twilio_call_sid: 'bad' }), /Invalid recording reference/);
  error = new Error('provider timeout');
  await assert.rejects(findCompletedRecording({ twilio_call_sid: parent }), /provider timeout/);
});
