import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../create-app.js';
const root=await mkdtemp(path.join(tmpdir(),'dimts-web-shell-'));
await writeFile(path.join(root,'index.html'),'<!doctype html><title>Dimts app shell</title>');
await writeFile(path.join(root,'asset.js'),'/* public asset */');
const server=createApp({webRoot:root}).listen(0),base=`http://127.0.0.1:${server.address().port}`;
test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('dimts-web-shell-'));
  await rm(root,{recursive:true,force:true});
});
test('known browser routes and UUID call deep links serve the app shell on refresh',async()=>{
  for(const route of ['/onboarding','/settings','/first-call','/demo-call','/dialer','/ask','/in-call','/person/01234567-89ab-cdef-0123-456789abcdef',
    '/call/01234567-89ab-cdef-0123-456789abcdef']) {
    const response=await fetch(base+route,{headers:{Accept:'text/html'}});
    assert.equal(response.status,200,route);assert.match(await response.text(),/Dimts app shell/);
    assert.equal(response.headers.get('cache-control'),'no-cache');
  }
  const asset=await fetch(base+'/asset.js');assert.equal(asset.status,200);assert.match(await asset.text(),/public asset/);
});
test('missing APIs, assets and malformed call paths never become successful HTML responses',async()=>{
  for(const route of ['/api/unknown','/missing.js','/call/not-a-uuid','/person/not-a-uuid','/notes','/unrecognized-screen']) {
    const response=await fetch(base+route,{headers:{Accept:'text/html'}});
    assert.equal(response.status,404,route);assert.match(response.headers.get('content-type'),/application\/json/);
    assert.deepEqual(await response.json(),{error:'not_found'});
  }
  const signedOut=await fetch(base+'/api/me',{headers:{Accept:'text/html'}});
  assert.equal(signedOut.status,401);assert.match(signedOut.headers.get('content-type'),/application\/json/);
  const json=await fetch(base+'/settings',{headers:{Accept:'application/json'}});assert.equal(json.status,404);
});
