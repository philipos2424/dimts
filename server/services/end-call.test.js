import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'synthetic';
const sid = 'CA' + 'b'.repeat(32);
let parent, children, receipts, updates;
const calls = id => ({ fetch: async () => ({ ...parent }), update: async options => {
  updates.push({ id, ...options }); parent.status = options.status;
} });
calls.list = async () => children;
mock.module('twilio', { defaultExport: () => ({ calls }) });
mock.module('../db/finish-call.js', { namedExports: {
  finishCall: async (_call, duration, status) => receipts.push({ duration, status }),
  finishDemoCall: async (_call, duration, status) => receipts.push({ demo: true, duration, status }),
} });
const { reconcileCall } = await import('./end-call.js');
const call = { id: 'owned-call', twilio_call_sid: sid, twilio_account_sid: process.env.TWILIO_ACCOUNT_SID };
test.beforeEach(() => { parent = { status: 'completed', duration: '500' }; children = []; receipts = []; updates = []; });
test('a completed parent without a dialled leg releases the active call with zero conversation duration', async () => {
  assert.deepEqual(await reconcileCall(call), { ended: true });
  assert.deepEqual(receipts, [{ duration: 0, status: 'completed' }]);
});
test('does not finalize a genuinely active parent', async () => {
  parent.status = 'in-progress';
  assert.deepEqual(await reconcileCall(call), { ended: false });
  assert.equal(receipts.length, 0);
});
test('bills the child conversation rather than the longer parent prompt duration', async () => {
  children = [{ parentCallSid: sid, status: 'completed', duration: '42' }];
  await reconcileCall(call);
  assert.deepEqual(receipts, [{ duration: 42, status: 'completed' }]);
});
test('End call completes the provider leg before finalizing the local call', async () => {
  parent.status = 'in-progress';
  await reconcileCall(call, { stop: true });
  assert.deepEqual(updates, [{ id: sid, status: 'completed' }]);
  assert.equal(receipts.length, 1);
});
test('rejects cross-account calls and ambiguous children without local finalization', async () => {
  await assert.rejects(reconcileCall({ ...call, twilio_account_sid: 'AC' + 'c'.repeat(32) }));
  children = [{ parentCallSid: sid }, { parentCallSid: sid }];
  await assert.rejects(reconcileCall(call));
  assert.equal(receipts.length, 0);
});

test('a demo is one leg: it ends on the parent alone, never through the billed finish', async () => {
  children = [{ sid: 'CA' + 'c'.repeat(32), parentCallSid: sid, status: 'in-progress', duration: '0' }];
  parent.duration = '61';
  assert.deepEqual(await reconcileCall({ ...call, demo: true }), { ended: true });
  assert.deepEqual(receipts, [{ demo: true, duration: 61, status: 'completed' }]);
});
