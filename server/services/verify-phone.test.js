import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
let failure, requests=0;
mock.module('../config.js', { namedExports:{config:{twilioAccountSid:'AC-test',twilioAuthToken:'test-token',twilioVerifyServiceSid:'VA-test'}} });
mock.module('twilio', { defaultExport: () => ({ verify:{v2:{services: () => ({
  verifications:{create:async params=>{
    requests++; assert.deepEqual(params,{to:'+15555550101',channel:'sms'});
    if(failure)throw failure; return {status:'pending'};
  }}, verificationChecks:{create:async()=>{if(failure)throw failure;return {status:'approved'};}},
})}}}) });
const {sendPhoneCode,checkPhoneCode}=await import('./verify-phone.js');
test.afterEach(()=>{failure=undefined;});
test('trial and geo restrictions become specific safe errors without retries',async()=>{
  for(const [providerCode,code] of [[21608,'verification_trial_number_required'],[60605,'verification_country_disabled']]) {
    failure=Object.assign(new Error('private-provider-details'),{code:providerCode,status:403});
    const before=requests;
    await assert.rejects(sendPhoneCode('+15555550101'),err=>err.status===403&&err.code===code&&!err.message.includes('private-provider'));
    assert.equal(requests,before+1);
  }
});
test('sending a code is not approval, and configuration errors are not mistaken for an invalid user code',async()=>{
  await sendPhoneCode('+15555550101');
  assert.equal(await checkPhoneCode('+15555550101','123456'),true);
  failure=Object.assign(new Error('authentication failure'),{code:20003,status:401});
  await assert.rejects(checkPhoneCode('+15555550101','123456'),{code:20003});
  for(const code of [20404,60202,60203]) {
    failure={code};assert.equal(await checkPhoneCode('+15555550101','123456'),false);
  }
});
