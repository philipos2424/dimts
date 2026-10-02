// Private call audio in Supabase Storage (EU). The server is the only reader:
// the app never receives storage URLs or keys.
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp3$/;

const base = () => process.env.SUPABASE_URL?.replace(/\/+$/, '');
const bucket = () => process.env.AUDIO_BUCKET || 'call-audio';

export const audioStoreConfigured = () => !!(base() && process.env.SUPABASE_SECRET_KEY);
export const objectKey = (userId, callId) => `${userId}/${callId}.mp3`;

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

export async function putAudio(key, bytes) {
  const response = await request(`object/${bucket()}/${checked(key)}`, {
    method: 'POST', body: bytes, headers: { 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' },
  });
  if (!response.ok) throw new Error(`Audio upload failed (HTTP ${response.status})`);
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
  return request(`object/authenticated/${bucket()}/${checked(key)}`, { signal, headers: range ? { Range: range } : {} });
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
