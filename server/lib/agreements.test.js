import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgreements } from './agreements.js';

const transcript = [
  'Caller: Hello, this is Abebe from Amax.',
  'User: We need 200 units.',
  'Caller: እሺ, fine, 450 birr per unit for 200 units.',
  'User: Delivery Tuesday then.',
].join('\n');
const turns = [
  { speaker: 'Caller', start: 0.4, end: 2, text: 'Hello, this is Abebe from Amax.' },
  { speaker: 'User', start: 2.5, end: 4, text: 'We need 200 units.' },
  { speaker: 'Caller', start: 191.2, end: 196, text: 'እሺ, fine, 450 birr per unit for 200 units.' },
  { speaker: 'User', start: 468.0, end: 470, text: 'Delivery Tuesday then.' },
];

test('line references resolve to the exact spoken line and its start time, including mixed Amharic and English', () => {
  const [price] = resolveAgreements([{ kind: 'price', subject: 'unit price', value: '450 birr', said_by: 'Caller', source_lines: [3] }], transcript, turns);
  assert.deepEqual(price, { kind: 'price', subject: 'unit price', value: '450 birr', said_by: 'Caller',
    quote: 'Caller: እሺ, fine, 450 birr per unit for 200 units.', line: 3, start: 191.2 });
});

test('an agreement citing a line that does not exist is dropped; the others are kept', () => {
  const result = resolveAgreements([
    { kind: 'date', subject: 'delivery', value: 'Tuesday', said_by: 'User', source_lines: [4] },
    { kind: 'price', subject: 'invented', value: '1 birr', said_by: 'Caller', source_lines: [99] },
    { kind: 'price', subject: 'no lines', value: '2 birr', said_by: 'Caller' },
    { kind: 'price', subject: 'fractional', value: '3 birr', said_by: 'Caller', source_lines: [1.5] },
  ], transcript, turns);
  assert.deepEqual(result.map(a => a.subject), ['delivery']);
});

test('unknown kinds become other, speakers are normalised, values are clipped and at most twelve are kept', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ kind: 'mystery', subject: `s${i}`, value: 'v'.repeat(300),
    said_by: i % 2 ? 'Caller' : 'someone', source_lines: [2] }));
  const result = resolveAgreements(many, transcript, turns);
  assert.equal(result.length, 12);
  assert.equal(result[0].kind, 'other');
  assert.equal(result[0].said_by, null);
  assert.equal(result[1].said_by, 'Caller');
  assert.equal(result[0].value.length, 200);
});

test('without matching timing, start is null rather than invented', () => {
  const [item] = resolveAgreements([{ kind: 'date', subject: 'delivery', value: 'Tuesday', said_by: 'User', source_lines: [4] }], transcript, []);
  assert.equal(item.start, null);
  const [other] = resolveAgreements([{ kind: 'date', subject: 'delivery', value: 'Tuesday', said_by: 'User', source_lines: [4] }],
    transcript, turns.slice(0, 2));
  assert.equal(other.start, null, 'turns that do not cover the transcript are not trusted');
});

test('malformed input yields no agreements', () => {
  for (const raw of [null, undefined, 'x', [null, 5, 'a', { subject: '', value: 'x', source_lines: [1] }]])
    assert.deepEqual(resolveAgreements(raw, transcript, turns), []);
});
