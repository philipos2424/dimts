import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encryption of conversation content before it reaches the database or
 * storage. A database dump or backup alone then reveals no conversations: the
 * master keys live only in the server's environment.
 *
 * DATA_ENCRYPTION_KEYS is "id:base64key[,id:base64key...]"; the first key
 * encrypts, every listed key can still decrypt (rotation). Each user gets
 * their own key, derived from the master key and their account ID.
 *
 * Sealed text is self-describing, so the database layer can open it without
 * knowing which query produced it:
 *   dmt1.<key id>.<table:column>.<user id>.<row id>.<base64url(iv|ciphertext|tag)>
 * Everything before the payload is authenticated, so content cannot be moved
 * to another user, row or column without failing to open.
 */
export const PREFIX = 'dmt1.';
const KEY_ID = /^[a-z0-9]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD = /^[a-z_]+:[a-z_]+$/;
// Columns whose plaintext is JSON: opened values are parsed back into objects.
const JSON_FIELDS = new Set(['calls:transcript_data', 'calls:followups', 'calendar_actions:meeting', 'email_actions:email']);

let parsed; let parsedFrom;
function keyring(env = process.env) {
  const source = env.DATA_ENCRYPTION_KEYS ?? '';
  if (parsed && parsedFrom === source) return parsed;
  const keys = new Map(); let current = null;
  for (const entry of source.split(',').map(s => s.trim()).filter(Boolean)) {
    const [id, encoded, extra] = entry.split(':');
    const key = Buffer.from(encoded ?? '', 'base64');
    if (extra !== undefined || !KEY_ID.test(id ?? '') || key.length !== 32 || keys.has(id)) {
      throw new Error('Invalid DATA_ENCRYPTION_KEYS');
    }
    keys.set(id, key); current ??= id;
  }
  parsed = { keys, current }; parsedFrom = source;
  userKeys.clear();
  return parsed;
}

/**
 * Whether content is encrypted before it is stored. Vercel production never
 * runs validateDeployment, so a missing key fails every write there instead
 * of silently storing plaintext.
 */
export function encryptionEnabled(env = process.env) {
  const enabled = !!keyring(env).current;
  if (!enabled && env.VERCEL_ENV === 'production') throw new Error('Set DATA_ENCRYPTION_KEYS');
  return enabled;
}
export const currentKeyId = () => keyring().current;

/** Throws on a malformed setting, so a typo stops deployment instead of writing plaintext. */
export function validateKeyring(env = process.env) {
  if (!keyring(env).current) throw new Error('Set DATA_ENCRYPTION_KEYS');
}

const userKeys = new Map();
export function userKey(userId, keyId) {
  const cacheKey = `${keyId}:${userId}`;
  let key = userKeys.get(cacheKey);
  if (!key) {
    const master = keyring().keys.get(keyId);
    if (!master) throw new Error('Unknown data encryption key');
    key = Buffer.from(hkdfSync('sha256', master, Buffer.from('dimts-user-data-v1'), Buffer.from(String(userId)), 32));
    if (userKeys.size > 5000) userKeys.clear();
    userKeys.set(cacheKey, key);
  }
  return key;
}

function checkContext({ userId, rowId, field }) {
  if (!UUID.test(String(userId)) || !UUID.test(String(rowId)) || !FIELD.test(field)) throw new Error('Invalid encryption context');
}

/** Encrypt text for one row's column. Without configured keys, plaintext passes through. */
export function sealText(value, context) {
  if (value == null || !encryptionEnabled()) return value;
  if (typeof value !== 'string') throw new Error('sealText needs a string');
  checkContext(context);
  // Already sealed for exactly this row and column (re-saving): keep it. Text a
  // user typed that merely looks sealed, or a value sealed for someone else,
  // is sealed as ordinary text, so pasting another user's ciphertext can never
  // make the server decrypt it.
  if (sealedFor(value, context)) return value;
  const { current } = keyring();
  const header = `${PREFIX}${current}.${context.field}.${String(context.userId).toLowerCase()}.${String(context.rowId).toLowerCase()}.`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', userKey(String(context.userId).toLowerCase(), current), iv);
  cipher.setAAD(Buffer.from(header));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return header + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/**
 * The parameter to bind to a JSONB column: the sealed JSON as a JSON string
 * when encrypting, or the plain JSON document otherwise.
 */
export function sealJson(value, context) {
  if (value == null) return null;
  const json = JSON.stringify(value);
  return encryptionEnabled() ? JSON.stringify(sealText(json, context)) : json;
}

export const isSealed = value => typeof value === 'string' && value.startsWith(PREFIX);

function sealedFor(value, { userId, rowId, field }) {
  const parts = sealedParts(value);
  return !!parts && parts.field === field && parts.userId === String(userId).toLowerCase()
    && parts.rowId === String(rowId).toLowerCase();
}

function sealedParts(value) {
  if (!isSealed(value)) return null;
  const parts = value.split('.');
  if (parts.length !== 6) return null;
  const [, keyId, field, userId, rowId, payload] = parts;
  if (!KEY_ID.test(keyId) || !FIELD.test(field) || !UUID.test(userId) || !UUID.test(rowId)) return null;
  return { keyId, field, userId, rowId, payload };
}

/**
 * Decrypt a sealed value; anything else (legacy plaintext, objects, text that
 * merely looks similar) is returned unchanged. Tampered ciphertext throws.
 */
export function openValue(value) {
  const parts = sealedParts(value);
  if (!parts) return value;
  const { keyId, field, userId, payload } = parts;
  const header = value.slice(0, value.length - payload.length);
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length < 28) throw new Error('Malformed sealed value');
  const decipher = createDecipheriv('aes-256-gcm', userKey(userId, keyId), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(header));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const text = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString('utf8');
  return JSON_FIELDS.has(field) ? JSON.parse(text) : text;
}

/**
 * Open every sealed column of a query result in place. Used by the database
 * layer. Only a value sealed for a column of the same name is opened.
 */
export function openRows(result) {
  for (const row of result?.rows ?? []) {
    for (const column of Object.keys(row)) {
      const parts = sealedParts(row[column]);
      if (!parts || parts.field.split(':')[1] !== column) continue;
      if (parts.field === 'file_actions:payload' &&
          (String(row.user_id).toLowerCase() !== parts.userId || String(row.id).toLowerCase() !== parts.rowId)) {
        throw new Error('Invalid file action encryption context');
      }
      // Every row belongs to one owner; never open a value sealed for another.
      if (row.user_id != null && String(row.user_id).toLowerCase() !== parts.userId) continue;
      row[column] = openValue(row[column]);
    }
  }
  return result;
}

export const sealedKeyId = value => isSealed(value) ? value.split('.')[1] : null;
