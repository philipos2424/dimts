import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { encryptionEnabled, isSealed, openRows, openValue, sealJson, sealText, validateKeyring } from './field-crypto.js';

const key = () => randomBytes(32).toString('base64');
const withKeys = (value, work) => {
  const before = process.env.DATA_ENCRYPTION_KEYS;
  if (value === undefined) delete process.env.DATA_ENCRYPTION_KEYS; else process.env.DATA_ENCRYPTION_KEYS = value;
  try { return work(); } finally {
    if (before === undefined) delete process.env.DATA_ENCRYPTION_KEYS; else process.env.DATA_ENCRYPTION_KEYS = before;
  }
};
const context = (field = 'calls:transcript') => ({ userId: randomUUID(), rowId: randomUUID(), field });

test('without keys, content passes through unchanged (local development and tests)', () => withKeys(undefined, () => {
  assert.equal(encryptionEnabled(), false);
  assert.equal(sealText('User: hello', context()), 'User: hello');
  assert.equal(sealJson({ a: 1 }, context('calls:transcript_data')), '{"a":1}');
  assert.throws(() => validateKeyring(), /Set DATA_ENCRYPTION_KEYS/);
}));

test('sealed text hides the content and opens back for the database layer', () => withKeys(`k1:${key()}`, () => {
  const ctx = context();
  const sealed = sealText('User: the price is 40,000 birr', ctx);
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes('birr') && !sealed.includes('price'));
  assert.notEqual(sealText('User: the price is 40,000 birr', ctx), sealed, 'a fresh IV each time');
  assert.equal(openValue(sealed), 'User: the price is 40,000 birr');
  const rows = openRows({ rows: [{ id: ctx.rowId, transcript: sealed, summary: null, status: 'ready' }] }).rows;
  assert.equal(rows[0].transcript, 'User: the price is 40,000 birr');
}));

test('JSON columns are stored as a sealed JSON string and come back as objects', () => withKeys(`k1:${key()}`, () => {
  const ctx = context('calls:transcript_data');
  const param = sealJson({ words: [{ text: 'hi', start: 0.1 }] }, ctx);
  const stored = JSON.parse(param);
  assert.ok(isSealed(stored));
  assert.deepEqual(openRows({ rows: [{ transcript_data: stored }] }).rows[0].transcript_data, { words: [{ text: 'hi', start: 0.1 }] });
}));

test('tampering, or moving content to another user, row or column, fails to open', () => withKeys(`k1:${key()}`, () => {
  const ctx = context();
  const sealed = sealText('secret', ctx);
  const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1);
  assert.throws(() => openValue(flipped));
  assert.throws(() => openValue(sealed.replace(ctx.userId, randomUUID())));
  assert.throws(() => openValue(sealed.replace(ctx.rowId, randomUUID())));
  assert.throws(() => openValue(sealed.replace('calls:transcript', 'calls:summary')));
}));

test('only a value sealed for that column is opened; look-alike user text is left alone', () => withKeys(`k1:${key()}`, () => {
  const sealed = sealText('notes', context('contacts:notes'));
  assert.equal(openRows({ rows: [{ display_name: sealed }] }).rows[0].display_name, sealed);
  assert.equal(openRows({ rows: [{ notes: 'dmt1.just some text' }] }).rows[0].notes, 'dmt1.just some text');
}));

test('rotation: a new first key encrypts, older keys still decrypt', () => {
  const oldKey = key();
  const sealed = withKeys(`old:${oldKey}`, () => sealText('kept', context()));
  withKeys(`new:${key()},old:${oldKey}`, () => {
    assert.equal(openValue(sealed), 'kept');
    assert.ok(sealText('fresh', context()).startsWith('dmt1.new.'));
  });
  withKeys(`new:${key()}`, () => assert.throws(() => openValue(sealed), /Unknown data encryption key/));
});

test('a malformed key setting is refused instead of silently writing plaintext', () => {
  for (const bad of ['k1:short', 'K1:' + key(), `k1:${key()},k1:${key()}`, `k1:${key()}:x`]) {
    withKeys(bad, () => assert.throws(() => encryptionEnabled(), /Invalid DATA_ENCRYPTION_KEYS/));
  }
});

test('Vercel production refuses to store content when the keys are missing', () => withKeys(undefined, () => {
  process.env.VERCEL_ENV = 'production';
  try { assert.throws(() => sealText('User: hi', context()), /Set DATA_ENCRYPTION_KEYS/); }
  finally { delete process.env.VERCEL_ENV; }
}));
