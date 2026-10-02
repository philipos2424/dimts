const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual client API module with browser-independent fetch/timers.
// No server session, phone call or external provider is used.
function loadApi(fetch) {
  const timers = new Map(); let nextTimer = 0, clears = 0;
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, fetch, AbortController,
    require: id => { assert.equal(id, 'react-native'); return { Platform: { OS: 'web' } }; },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id,{callback,delay}); return id; },
    clearTimeout: id => { if (timers.delete(id)) clears++; }, process: { env: {} },
  });
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/api.ts'),'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(source,{filename:'client-api.js'}).runInContext(context);
  return { api:module.exports, timers, cleared:()=>clears };
}

test('a hung call-start request aborts after 30 seconds without losing its idempotency key or exposing the session',async()=>{
  const attempts=[];
  const harness=loadApi(async(url,init)=>{
    attempts.push({url,init});
    return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('Bearer secret detail')),{once:true}));
  });
  harness.api.setApiSession('a'.repeat(64));
  for(let i=0;i<2;i++) {
    const pending=harness.api.startCall('+15555550102','+15555550101',true,'same-request-key');
    const timer=[...harness.timers.values()][0];assert.equal(timer.delay,30_000);timer.callback();
    await assert.rejects(pending,err=>err.messageKey==='errorNetwork' && err.status===undefined &&
      /timed out/.test(err.message) && !/Bearer|secret detail/.test(err.message));
  }
  assert.equal(attempts.length,2);
  for(const {url,init} of attempts) {
    assert.equal(url,'/api/calls');assert.equal(init.headers['Idempotency-Key'],'same-request-key');
    assert.equal(init.headers.Authorization,`Bearer ${'a'.repeat(64)}`);assert.ok(init.signal.aborted);
  }
  assert.equal(harness.timers.size,0);assert.equal(harness.cleared(),2);
});

test('the timeout also covers a stalled response body and successful responses clear their timer',async()=>{
  let pendingSignal;
  let bodyStarted;
  const readingBody=new Promise(resolve=>{bodyStarted=resolve;});
  const harness=loadApi(async(_url,init)=>{
    pendingSignal=init.signal;
    return {ok:true,json:()=>new Promise((_resolve,reject)=>{
      init.signal.addEventListener('abort',()=>reject(new Error('body interrupted')),{once:true});bodyStarted();
    })};
  });
  const pending=harness.api.getMe();await readingBody;
  [...harness.timers.values()][0].callback();
  await assert.rejects(pending,err=>err.messageKey==='errorNetwork');assert.ok(pendingSignal.aborted);
  assert.equal(harness.timers.size,0);
  const success=loadApi(async()=>({ok:true,json:async()=>({phone:'+15555550101'})}));
  assert.equal((await success.api.getMe()).phone,'+15555550101');assert.equal(success.timers.size,0);
});

test('HTTP call failures retain their status so the dialer can distinguish rejection from a lost response',async()=>{
  const harness=loadApi(async()=>({ok:false,status:409,text:async()=>'call_in_progress'}));
  await assert.rejects(harness.api.startCall('+15555550102','+15555550101',true,'request-key'),
    err=>err.messageKey==='errorCallFailed' && err.status===409);
  assert.equal(harness.timers.size,0);
});

test('provider and server details never appear in public error messages, including malformed responses', async()=>{
  for (const body of ['{"error":"internal_error","message":"password-secret"}', '<html>secret-token</html>',
    '{broken-secret', JSON.stringify({error:'session_expired',message:'secret-token'}),
    JSON.stringify({error:'invalid_code',message:'secret-token'})]) {
    const harness=loadApi(async()=>({ok:false,status:500,text:async()=>body}));
    await assert.rejects(harness.api.sendLoginCode('+15555550101'),err=>err.status===500 &&
      /try again shortly/.test(err.message) && !/secret|HTTP|internal_error|expired|incorrect/.test(err.message));
    assert.equal(harness.timers.size,0);
  }
});

test('signup and call rejection messages explain the next step while retaining their status', async()=>{
  for (const [code,status,expected] of [['invalid_code',401,/incorrect or expired/],
    ['handset_required',400,/mobile number you will answer/],['session_expired',401,/sign in again/],
    ['call_in_progress',409,/Finish your current call/],['daily_call_limit',429,/today/],
    ['constructor',400,/Check your details/],['too_many_attempts',429,/wait/]]) {
    const harness=loadApi(async()=>({ok:false,status,text:async()=>JSON.stringify({error:code,message:'secret'})}));
    await assert.rejects(harness.api.sendLoginCode('+15555550101'),err=>err.status===status && expected.test(err.message) && !/secret/.test(err.message));
  }
});

test('verification provider restrictions explain trial and country setup rather than claiming the user lacks access',async()=>{
  for(const [code,expected] of [['verification_trial_number_required',/Twilio trial account.*Verify this mobile number/],
    ['verification_country_disabled',/not enabled for this country/]]) {
    const harness=loadApi(async()=>({ok:false,status:403,text:async()=>JSON.stringify({error:code,message:'private-provider-details'})}));
    await assert.rejects(harness.api.sendLoginCode('+15555550101'),err=>err.status===403&&expected.test(err.message)&&
      !/private-provider|not available for your account/.test(err.message));
  }
});
