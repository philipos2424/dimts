import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const account='AC'+'a'.repeat(32), parent='CA'+'b'.repeat(32), sid='RE'+'c'.repeat(32);
process.env.TWILIO_ACCOUNT_SID=account; process.env.TWILIO_AUTH_TOKEN='test-token';
let recording, missing=false, timeout=false, listed=[], removes=0, softDelete=false, interruptDelete=false, clients=0;
mock.module('twilio', { defaultExport: (_a,_t, options) => {
  clients++;
  assert.equal(_a, process.env.TWILIO_ACCOUNT_SID);
  assert.equal(options.autoRetry,false); assert.equal(options.timeout,10_000);
  return { recordings: id => ({ fetch: async () => {
    assert.equal(id,sid); if (timeout) throw new Error('secret provider detail');
    if (missing) throw Object.assign(new Error('missing'),{status:404}); return recording;
  }, remove: async () => { removes++; if(softDelete)recording.status='deleted';else missing=true;
    if(interruptDelete)throw new Error('Deletion response interrupted'); } }), calls: id => ({ recordings: { list: async options => {
    assert.equal(id,parent); assert.deepEqual(options,{limit:2,pageSize:2}); return listed;
  } } }) };
} });
const { deleteProviderRecording }=await import('./delete-recording.js');
test.beforeEach(()=>{process.env.TWILIO_ACCOUNT_SID=account;recording={accountSid:account,callSid:parent,sid,status:'completed'};missing=false;timeout=false;listed=[];removes=0;softDelete=false;interruptDelete=false;clients=0;});

test('an absent recording in another account never confirms removal; legacy unknown ownership makes no provider request',async()=>{
  missing=true;
  process.env.TWILIO_ACCOUNT_SID='AC'+'d'.repeat(32);
  assert.deepEqual(await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid}),{status:'unknown',error:'account_changed'});
  assert.deepEqual(await deleteProviderRecording({twilio_call_sid:parent,recording_sid:sid}),{status:'unknown',error:'account_unverified'});
  assert.equal(clients,0);assert.equal(removes,0);
  process.env.TWILIO_ACCOUNT_SID=account;
  assert.deepEqual(await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid}),{status:'confirmed'});
  assert.equal(clients,1);
});
test('deletes only an owned recording and independently verifies absence; retry after removal never deletes again',async()=>{
  assert.deepEqual(await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid}),{status:'confirmed'});
  assert.equal(removes,1);
  assert.deepEqual(await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid}),{status:'confirmed'});
  assert.equal(removes,1);
});
test('retained deleted metadata confirms removal, including a retry after an interrupted delete response',async()=>{
  softDelete=true;
  assert.deepEqual(await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid}),{status:'confirmed'});
  assert.equal(recording.status,'deleted');assert.equal(removes,1);
  recording.status='completed';interruptDelete=true;
  assert.equal((await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid})).status,'unknown');
  const before=removes;
  assert.equal((await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid})).status,'confirmed');assert.equal(removes,before);
});
test('unknown SID uses its call lookup, but ambiguous or mismatched resources are never deleted',async()=>{
  listed=[recording]; assert.equal((await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent})).status,'confirmed');
  missing=false;removes=0;listed=[recording,recording];
  assert.equal((await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent})).error,'multiple_recordings');assert.equal(removes,0);
  for(const change of [{accountSid:'AC'+'d'.repeat(32)},{callSid:'CA'+'d'.repeat(32)}]){
    const wrong={...recording,...change};listed=[wrong];
    assert.equal((await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent})).error,'owner_mismatch');
  }
  recording={...recording,sid:'RE'+'d'.repeat(32)};
  assert.equal((await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid})).error,'owner_mismatch');
  assert.equal(removes,0);
});
test('invalid, active and unavailable provider references retain an unconfirmed result without leaking provider details',async()=>{
  assert.equal((await deleteProviderRecording({twilio_call_sid:'bad'})).error,'invalid_reference');
  recording.status='in-progress';assert.equal((await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid})).error,'recording_unfinished');
  timeout=true;assert.deepEqual(await deleteProviderRecording({twilio_account_sid:account,twilio_call_sid:parent,recording_sid:sid}),{status:'unknown',error:'provider_unavailable'});
  assert.equal(removes,0);
});
