import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
process.env.DATA_ENCRYPTION_KEYS = `k1:${randomBytes(32).toString('base64')}`;
const { getAudio, headAudio, objectKey, plainRange, putAudio } = await import('./audio-store.js');

const user = '11111111-1111-4111-8111-111111111111', call = '22222222-2222-4222-8222-222222222222';
const stored = new Map();
// A minimal Supabase Storage: upload, HEAD and ranged GET.
globalThis.fetch = async (url, init = {}) => {
  const name = decodeURIComponent(String(url).replace(/^.*\/call-audio\//, ''));
  if (init.method === 'POST') { stored.set(name, Buffer.from(init.body)); return new Response('{}'); }
  const bytes = stored.get(name);
  if (!bytes) return new Response(null, { status: 400 });
  if (init.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(bytes.length) } });
  const range = init.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
  if (!range) return new Response(bytes);
  const end = Math.min(Number(range[2]), bytes.length - 1);
  return new Response(bytes.subarray(Number(range[1]), end + 1), { status: 206,
    headers: { 'content-range': `bytes ${range[1]}-${end}/${bytes.length}` } });
};

const audio = randomBytes(64 * 1024 * 3 + 1234);   // four chunks, the last one short
const key = objectKey(user, call);

test('with keys set, new recordings are stored encrypted and unreadable in storage', async () => {
  assert.equal(key, `${user}/${call}.enc`);
  const size = await putAudio(key, audio);
  assert.equal((await headAudio(key)).size, size);
  const raw = stored.get(key);
  assert.equal(raw.subarray(0, 4).toString(), 'DMA1');
  assert.equal(raw.indexOf(audio.subarray(5000, 5032)), -1, 'no plaintext run survives');
});

test('the whole recording reads back as the original MP3', async () => {
  const response = await getAudio(key);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Number(response.headers.get('content-length')), audio.length);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(audio));
});

test('ranges are served across chunk boundaries, open-ended and from the end', async () => {
  for (const [range, start, end] of [
    ['bytes=0-99', 0, 99], ['bytes=65530-65545', 65530, 65545], ['bytes=131000-', 131000, audio.length - 1],
    ['bytes=-500', audio.length - 500, audio.length - 1], ['bytes=10-999999999', 10, audio.length - 1],
  ]) {
    const response = await getAudio(key, { range });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${audio.length}`);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(audio.subarray(start, end + 1)), range);
  }
  const beyond = await getAudio(key, { range: `bytes=${audio.length}-` });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), `bytes */${audio.length}`);
});

test('a modified, truncated or moved recording fails instead of playing altered audio', async () => {
  const original = stored.get(key);
  const flipped = Buffer.from(original); flipped[100] ^= 1;
  stored.set(key, flipped);
  await assert.rejects(async () => (await getAudio(key, { range: 'bytes=0-10' })).arrayBuffer());
  stored.set(key, original.subarray(0, original.length - 30));
  await assert.rejects(async () => (await getAudio(key)).arrayBuffer());
  const other = `${user}/33333333-3333-4333-8333-333333333333.enc`;
  stored.set(other, original);
  await assert.rejects(async () => (await getAudio(other)).arrayBuffer());
  stored.set(key, original);
});

test('a missing object is reported as not found, like an unencrypted one', async () => {
  const response = await getAudio(`${user}/44444444-4444-4444-8444-444444444444.enc`);
  assert.equal(response.ok, false);
});

test('range arithmetic', () => {
  assert.deepEqual(plainRange(undefined, 10), [0, 9]);
  assert.deepEqual(plainRange('bytes=-3', 10), [7, 9]);
  assert.equal(plainRange('bytes=10-', 10), null);
  assert.equal(plainRange('bytes=5-2', 10), null);
});
