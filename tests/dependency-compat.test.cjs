const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const queryString = require('query-string');
const decode = createRequire(require.resolve('query-string'))('decode-uri-component');
const xcode = require('xcode');
const uuid = createRequire(require.resolve('xcode'))('uuid');

test('router query parsing preserves Unicode, repeated values and encoded punctuation with the patched decoder', () => {
  const decoderRequire = createRequire(createRequire(require.resolve('query-string')).resolve('decode-uri-component'));
  const decoderMetadata = JSON.parse(readFileSync(join(dirname(decoderRequire.resolve('decode-uri-component-patched')), 'package.json'), 'utf8'));
  assert.equal(decoderMetadata.name, 'decode-uri-component');
  assert.equal(decoderMetadata.version, '0.5.0');
  assert.equal(decode, decoderRequire('decode-uri-component-patched').default);
  const parsed = queryString.parse('name=%E1%8D%8A%E1%88%8A&value=a%26b%3Dc&tag=one&tag=two&empty=&flag');
  assert.equal(parsed.name, 'ፊሊ'); assert.equal(parsed.value, 'a&b=c');
  assert.deepEqual(parsed.tag, ['one', 'two']); assert.equal(parsed.empty, ''); assert.equal(parsed.flag, null);
  const original = { subject: 'Call + proposal', recipient: 'a@example.com' };
  assert.deepEqual({ ...queryString.parse(queryString.stringify(original)) }, original);
});

test('malformed URI decoding remains bounded and retains valid portions rather than crashing query parsing', () => {
  assert.equal(typeof decode, 'function');
  assert.equal(decode('%41%'), 'A%');
  const malformed = '%E0%A4%A'.repeat(10_000);
  const started = performance.now();
  const result = queryString.parse(`value=${malformed}`);
  assert.equal(typeof result.value, 'string');
  assert.ok(performance.now() - started < 2000, 'malformed input should not consume exponential CPU time');
});

test('Xcode project IDs still use valid uppercase 24-character IDs after the UUID patch', () => {
  const project = xcode.project('unused-test-project.pbxproj');
  project.hash = require('xcode/lib/parser/pbxproj').parse(`{
    archiveVersion = 1; classes = {}; objectVersion = 56;
    objects = { AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXProject; }; };
    rootObject = AAAAAAAAAAAAAAAAAAAAAAAA;
  }\n`);
  const ids = Array.from({ length: 100 }, () => project.generateUuid());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-F0-9]{24}$/);
  assert.throws(() => uuid.v5('Dimts', uuid.v5.DNS, Buffer.alloc(1)), RangeError);
});
