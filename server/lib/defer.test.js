import test from 'node:test';
import assert from 'node:assert/strict';
import { defer, drainDeferredWork } from './defer.js';
const barrier = () => { let release; const promise = new Promise(resolve => { release=resolve; }); return {promise,release}; };

test('drain waits for pending work and jobs spawned during its completion',async () => {
  const first=barrier(),child=barrier();
  defer(first.promise.then(() => { defer(child.promise,'child'); }),'parent');
  let drained=false;
  const draining=drainDeferredWork().then(() => { drained=true; });
  first.release();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(drained,false);
  child.release();await draining;
  assert.equal(drained,true);
  await drainDeferredWork();
});

test('rejected jobs settle without leaking provider exception details to logs',async () => {
  const messages=[];
  const original=console.error;
  console.error=(...args)=>messages.push(args.join(' '));
  try {
    await defer(Promise.reject(new Error('private transcript and token=do-not-log')),'synthetic');
    await drainDeferredWork();
    assert.equal(messages.length,1);
    assert.match(messages[0],/Background task failed/);
    assert.doesNotMatch(messages[0],/private transcript|do-not-log/);
  } finally { console.error=original; }
});
