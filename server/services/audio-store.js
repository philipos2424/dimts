import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { currentKeyId, encryptionEnabled, userKey } from '../lib/field-crypto.js';

// Private call audio in Supabase Storage (EU). The server is the only reader:
// the app never receives storage URLs or keys.
// New recordings are stored encrypted (.enc) when DATA_ENCRYPTION_KEYS is set;
// older plain .mp3 objects stay readable until re-encrypted.
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp3|enc)$/;

const base = () => process.env.SUPABASE_URL?.replace(/\/+$/, '');
const bucket = () => process.env.AUDIO_BUCKET || 'call-audio';

export const audioStoreConfigured = () => !!(base() && process.env.SUPABASE_SECRET_KEY);
export const objectKey = (userId, callId) => `${userId}/${callId}.${encryptionEnabled() ? 'enc' : 'mp3'}`;
export const isEncryptedKey = key => typeof key === 'string' && key.endsWith('.enc');

function checked(key) {
  if (typeof key !== 'string' || !KEY.test(key)) throw new Error('Invalid object key');
  return key;
}

function request(path, { method = 'GET', headers = {}, body, signal } = {}) {
  if (!audioStoreConfigured()) throw new Error('Audio storage is not configured');
  const secret = process.env.SUPABASE_SECRET_KEY;
  const timeout = AbortSignal.timeout(30_000);
  return fetch(`${base()}/storage/v1/${path}`, {
    method, body, redirect: 'error',
    headers: { Authorization: `Bearer ${secret}`, apikey: secret, ...headers },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

/*
 * Encrypted object layout: "DMA1" + key id (8 bytes, zero-padded), then the
 * MP3 in 64 KiB chunks, each stored as iv(12) | ciphertext | tag(16). Chunks
 * let the player seek: a range request decrypts only the chunks it covers.
 * Each chunk is bound to its object, position and the chunk count, so chunks
 * cannot be reordered, swapped between calls or silently truncated.
 */
const MAGIC = 'DMA1', HEADER = 12, CHUNK = 64 * 1024, OVERHEAD = 28;

const ownerOf = key => key.slice(0, 36);
const chunkAad = (key, index, count) => Buffer.from(`${key}|${index}|${count}`);
const chunkCount = bodyLength => Math.ceil(bodyLength / (CHUNK + OVERHEAD));

export function encryptAudio(key, bytes) {
  const keyId = currentKeyId();
  const secret = userKey(ownerOf(key), keyId);
  const plain = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  const count = Math.max(1, Math.ceil(plain.length / CHUNK));
  const parts = [Buffer.from(MAGIC), Buffer.from(keyId.padEnd(8, '\0'))];
  for (let index = 0; index < count; index++) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(chunkAad(key, index, count));
    parts.push(iv, cipher.update(plain.subarray(index * CHUNK, (index + 1) * CHUNK)), cipher.final(), cipher.getAuthTag());
  }
  return Buffer.concat(parts);
}

/** Uploads the recording and returns the number of bytes stored. */
export async function putAudio(key, bytes) {
  const encrypted = isEncryptedKey(checked(key));
  const body = encrypted ? encryptAudio(key, bytes) : bytes;
  const response = await request(`object/${bucket()}/${key}`, {
    method: 'POST', body, headers: { 'Content-Type': encrypted ? 'application/octet-stream' : 'audio/mpeg', 'x-upsert': 'true' },
  });
  if (!response.ok) throw new Error(`Audio upload failed (HTTP ${response.status})`);
  return body.byteLength;
}

/** Stored size, or null when the object does not exist. */
export async function headAudio(key) {
  const response = await request(`object/authenticated/${bucket()}/${checked(key)}`, { method: 'HEAD' });
  // Supabase Storage reports a missing object as 400 or 404.
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error(`Audio check failed (HTTP ${response.status})`);
  return { size: Number(response.headers.get('content-length')) };
}

export async function getAudio(key, { range, signal } = {}) {
  if (range && (range.length > 64 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) throw new Error('Invalid audio range');
  if (isEncryptedKey(checked(key))) return getEncryptedAudio(key, { range, signal });
  return request(`object/authenticated/${bucket()}/${key}`, { signal, headers: range ? { Range: range } : {} });
}

/** Requested plaintext bytes [start, end], or null when the range cannot be served. */
export function plainRange(range, size) {
  if (!range) return size ? [0, size - 1] : null;
  const [, from, to] = range.match(/^bytes=(\d*)-(\d*)$/);
  if (from === '') return size && Number(to) > 0 ? [Math.max(0, size - Number(to)), size - 1] : null;
  const start = Number(from), end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return start < size && start <= end ? [start, end] : null;
}

/**
 * Serve an encrypted object as if it were the plain MP3, honouring Range.
 * Returns a standard Response so callers treat both kinds of object alike.
 */
async function getEncryptedAudio(key, { range, signal }) {
  const object = `object/authenticated/${bucket()}/${key}`;
  const head = await request(object, { signal, headers: { Range: `bytes=0-${HEADER - 1}` } });
  if (!head.ok) return head;
  const prefix = Buffer.from(await head.arrayBuffer());
  const total = head.status === 206 ? Number(head.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]) : prefix.length;
  if (!Number.isSafeInteger(total) || total < HEADER + OVERHEAD || prefix.subarray(0, 4).toString() !== MAGIC) {
    throw new Error('Stored audio is not a valid encrypted recording');
  }
  const secret = userKey(ownerOf(key), prefix.subarray(4, HEADER).toString().replace(/\0+$/, ''));
  const bodyLength = total - HEADER, count = chunkCount(bodyLength), size = bodyLength - count * OVERHEAD;
  const wanted = plainRange(range, size);
  if (!wanted) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  const [start, end] = wanted;
  const first = Math.floor(start / CHUNK), last = Math.floor(end / CHUNK);
  const from = HEADER + first * (CHUNK + OVERHEAD), to = Math.min(HEADER + (last + 1) * (CHUNK + OVERHEAD), total) - 1;
  const upstream = await request(object, { signal, headers: { Range: `bytes=${from}-${to}` } });
  if (!upstream.ok || !upstream.body) throw new Error(`Could not read stored audio (HTTP ${upstream.status})`);
  if (upstream.status !== 206 && (from !== 0 || to !== total - 1)) throw new Error('Storage ignored the audio range');

  const chunkLength = index => index < count - 1 ? CHUNK + OVERHEAD : bodyLength - (count - 1) * (CHUNK + OVERHEAD);
  async function* plaintext() {
    let pending = Buffer.alloc(0), index = first, offset = first * CHUNK;
    for await (const piece of upstream.body) {
      pending = Buffer.concat([pending, piece]);
      while (index <= last && pending.length >= chunkLength(index)) {
        const sealed = pending.subarray(0, chunkLength(index));
        pending = pending.subarray(chunkLength(index));
        const decipher = createDecipheriv('aes-256-gcm', secret, sealed.subarray(0, 12));
        decipher.setAAD(chunkAad(key, index, count));
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        const plain = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
        const slice = plain.subarray(Math.max(0, start - offset), Math.min(plain.length, end - offset + 1));
        if (slice.length) yield slice;
        offset += plain.length; index++;
      }
    }
    if (index <= last) throw new Error('Stored audio ended early');
  }
  const headers = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1) };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  return new Response(ReadableStream.from(plaintext()), { status: range ? 206 : 200, headers });
}

/** 'confirmed' only when an independent check afterwards finds nothing. */
export async function removeAudio(key) {
  try {
    const response = await request(`object/${bucket()}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [checked(key)] }),
    });
    if (!response.ok) return 'unknown';
    return (await headAudio(key)) === null ? 'confirmed' : 'unknown';
  } catch (err) {
    if (err?.message === 'Invalid object key') throw err;
    return 'unknown';
  }
}
