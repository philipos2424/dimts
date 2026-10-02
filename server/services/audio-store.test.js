import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = 'https://proj.supabase.co/';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
const { objectKey, putAudio, headAudio, getAudio, removeAudio, audioStoreConfigured } = await import('./audio-store.js');
const user = '11111111-1111-4111-8111-111111111111', call = '22222222-2222-4222-8222-222222222222';
const key = objectKey(user, call);
let calls = [], responses = [];
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return responses.shift(); };
test.beforeEach(() => { calls = []; responses = []; });

test('object keys are scoped by owner and call, and malformed keys are refused', async () => {
  assert.equal(key, `${user}/${call}.mp3`);
  for (const bad of ['../x.mp3', `/${key}`, `${user}/${call}.wav`, `${user}/../${call}.mp3`]) {
    await assert.rejects(putAudio(bad, new Uint8Array([1])), /Invalid object key/);
  }
  assert.equal(calls.length, 0);
});

test('putAudio upserts private MP3 bytes with the server key and fails loudly', async () => {
  responses.push(new Response('{}', { status: 200 }));
  await putAudio(key, new Uint8Array([1, 2, 3]));
  const [{ url, init }] = calls;
  assert.equal(url, `https://proj.supabase.co/storage/v1/object/call-audio/${key}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-upsert'], 'true');
  assert.equal(init.headers['Content-Type'], 'audio/mpeg');
  assert.equal(init.headers.Authorization, 'Bearer sb_secret_test');
  assert.equal(init.headers.apikey, 'sb_secret_test');
  assert.equal(init.redirect, 'error');
  responses.push(new Response('nope', { status: 400 }));
  await assert.rejects(putAudio(key, new Uint8Array([1])), /upload failed \(HTTP 400\)/);
});

test('headAudio reports the stored size, null when absent, and throws on errors', async () => {
  responses.push(new Response(null, { status: 200, headers: { 'content-length': '3' } }));
  assert.deepEqual(await headAudio(key), { size: 3 });
  assert.equal(calls[0].init.method, 'HEAD');
  assert.equal(calls[0].url, `https://proj.supabase.co/storage/v1/object/authenticated/call-audio/${key}`);
  responses.push(new Response(null, { status: 404 }), new Response(null, { status: 400 }));
  assert.equal(await headAudio(key), null);
  assert.equal(await headAudio(key), null, 'storage reports a missing object as 400 too');
  responses.push(new Response(null, { status: 500 }));
  await assert.rejects(headAudio(key), /HTTP 500/);
});

test('getAudio forwards a valid byte range and refuses an invalid one before fetching', async () => {
  responses.push(new Response('ab', { status: 206 }));
  const response = await getAudio(key, { range: 'bytes=0-1' });
  assert.equal(response.status, 206);
  assert.equal(calls[0].init.headers.Range, 'bytes=0-1');
  await assert.rejects(getAudio(key, { range: 'bytes=0-1,5-6' }), /Invalid audio range/);
  assert.equal(calls.length, 1);
});

test('removeAudio confirms only after an independent check finds nothing', async () => {
  responses.push(new Response('[]', { status: 200 }), new Response(null, { status: 404 }));
  assert.equal(await removeAudio(key), 'confirmed');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].url, 'https://proj.supabase.co/storage/v1/object/call-audio');
  assert.deepEqual(JSON.parse(calls[0].init.body), { prefixes: [key] });
  responses.push(new Response('[]', { status: 200 }), new Response(null, { status: 200, headers: { 'content-length': '3' } }));
  assert.equal(await removeAudio(key), 'unknown');
  responses.push(new Response('err', { status: 503 }));
  assert.equal(await removeAudio(key), 'unknown');
});

test('the store is only configured when both URL and secret key are set', () => {
  assert.equal(audioStoreConfigured(), true);
  const saved = process.env.SUPABASE_SECRET_KEY; delete process.env.SUPABASE_SECRET_KEY;
  assert.equal(audioStoreConfigured(), false);
  process.env.SUPABASE_SECRET_KEY = saved;
});
