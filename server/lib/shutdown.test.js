import test from 'node:test';
import assert from 'node:assert/strict';
import { createShutdownHandler } from './shutdown.js';
import { createServer, get } from 'node:http';
import { defer, drainDeferredWork } from './defer.js';
const barrier = () => { let release; const promise = new Promise(resolve => { release=resolve; }); return {promise,release}; };
function harness(overrides={}) {
  const events=[],logs=[],exits=[];let expire;
  const stop=createShutdownHandler({
    server:{close:callback=>{events.push('close-http');callback();},closeAllConnections:()=>events.push('force-close')},
    drain:async()=>{events.push('drain');},closeDatabase:async()=>{events.push('close-db');},
    exit:code=>exits.push(code),log:message=>logs.push(message),
    setTimer:(callback,ms)=>{assert.equal(ms,45000);expire=callback;return 123;},
    clearTimer:id=>{assert.equal(id,123);events.push('clear-timer');},...overrides,
  });
  return {stop,events,logs,exits,expire:()=>expire()};
}
test('shutdown closes HTTP intake before draining jobs and database, once for repeated signals',async()=>{
  const h=harness();const running=h.stop();assert.equal(h.stop(),running);
  assert.equal(await running,'complete');
  assert.deepEqual(h.events,['close-http','drain','close-db','clear-timer']);
  assert.deepEqual(h.exits,[0]);assert.match(h.logs.at(-1),/Shutdown complete/);
});
test('an in-flight HTTP request finishes before job drain or database teardown',async()=>{
  let finishRequest;const job=barrier();let drained=false,closed=false;
  const h=harness({server:{close:callback=>{finishRequest=callback;}},
    drain:async()=>{drained=true;await job.promise;},closeDatabase:async()=>{closed=true;}});
  const result=h.stop();assert.equal(drained,false);assert.equal(closed,false);
  finishRequest();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(drained,true);assert.equal(closed,false);
  job.release();assert.equal(await result,'complete');assert.equal(closed,true);
});
test('deadline does not falsely claim an unfinished provider job completed',async()=>{
  const job=barrier();let dbClosed=false;
  const h=harness({drain:()=>job.promise,closeDatabase:async()=>{dbClosed=true;}});
  const running=h.stop();await new Promise(resolve=>setImmediate(resolve));h.expire();
  assert.equal(await running,'timeout');assert.equal(dbClosed,false);
  assert.deepEqual(h.exits,[1]);assert.ok(h.events.includes('force-close'));
  assert.match(h.logs.at(-1),/outcomes require reconciliation/);
  job.release();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.exits,[1]);
});
test('database close shares the deadline and teardown errors stay sanitized',async()=>{
  const closing=barrier();const h=harness({closeDatabase:()=>closing.promise});
  const running=h.stop();await new Promise(resolve=>setImmediate(resolve));h.expire();
  assert.equal(await running,'timeout');assert.deepEqual(h.exits,[1]);closing.release();
  const failed=harness({closeDatabase:async()=>{throw new Error('postgres://private:password@host');}});
  assert.equal(await failed.stop(),'failed');assert.deepEqual(failed.exits,[1]);
  assert.doesNotMatch(failed.logs.join(' '),/postgres|password/);
});
test('real HTTP server rejects new connections, finishes an active response and drains tracked work',async t=>{
  const entered=barrier(),response=barrier(),job=barrier();let databaseClosed=false;
  const server=createServer(async (_req,res)=>{
    entered.release();await response.promise;
    defer(job.promise,'shutdown-integration');res.end('synthetic response');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{response.release();job.release();server.closeAllConnections();server.close();});
  const address=`http://127.0.0.1:${server.address().port}`;
  const request=()=>new Promise((resolve,reject)=>{
    get(address,{agent:false},res=>{let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve(text));})
      .on('error',reject);
  });
  const active=request();await entered.promise;
  const exits=[];
  const stop=createShutdownHandler({server,drain:drainDeferredWork,
    closeDatabase:async()=>{databaseClosed=true;},exit:code=>exits.push(code),log:()=>{}});
  const stopping=stop();
  await assert.rejects(request(),error=>error.code==='ECONNREFUSED');
  assert.equal(databaseClosed,false);response.release();
  assert.equal(await active,'synthetic response');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(databaseClosed,false);assert.deepEqual(exits,[]);
  job.release();assert.equal(await stopping,'complete');
  assert.equal(databaseClosed,true);assert.deepEqual(exits,[0]);
});
