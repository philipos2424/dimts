import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'synthetic';
let account, numbers, lookupError, reads;
mock.module('twilio', { defaultExport: () => ({
  api: { v2010: { accounts: () => ({ fetch: async () => {
    if (lookupError) throw new Error('private provider error');
    return account;
  } }) } },
  outgoingCallerIds: { list: async ({ phoneNumber }) => {
    reads++; return numbers.includes(phoneNumber) ? [{ phoneNumber }] : [];
  } },
}) });
const { checkCallDestination } = await import('./call-preflight.js');
const owner = '+15555550101', target = '+15555550102';
test.beforeEach(() => { account = { type: 'Trial', status: 'active' }; numbers = [owner, target]; lookupError = false; reads = 0; });
test('allows both verified trial legs', async () => {
  await checkCallDestination(owner, target); assert.equal(reads, 2);
});
test('identifies which trial leg needs verification', async () => {
  numbers = [owner];
  await assert.rejects(checkCallDestination(owner, target), { status: 403, code: 'destination_trial_number_required' });
  numbers = [target];
  await assert.rejects(checkCallDestination(owner, target), { status: 403, code: 'handset_trial_number_required' });
});
test('upgraded accounts do not require verified destinations', async () => {
  account.type = 'Full'; numbers = [];
  await checkCallDestination(owner, target); assert.equal(reads, 0);
});
test('failed provider checks block calling and hide provider error bodies', async () => {
  lookupError = true;
  await assert.rejects(checkCallDestination(owner, target), error => {
    assert.equal(error.status, 503); assert.equal(error.code, 'call_preflight_unavailable');
    assert.doesNotMatch(error.message, /private/); return true;
  });
});
