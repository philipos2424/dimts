import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileRequests } from './file-requests.js';

test('caller requests and multiple channels retain exact source quotes', () => {
  const transcript = 'Caller: Send me the price list on Telegram.\nUser: I will send the photos on WhatsApp.';
  const result = parseFileRequests(JSON.stringify({ actions: [
    { request: 'Price list', channel: 'telegram', source_lines: [1] },
    { request: 'Photos', channel: 'whatsapp', source_lines: [2] },
  ] }), transcript);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].evidence, [transcript.split('\n')[0]]);
  assert.equal(result[0].caption, '');
});
test('fabricated references and unspecified channels cannot become review cards', () => {
  for (const action of [
    { request: 'File', channel: 'telegram', source_lines: [2] },
    { request: 'File', channel: 'whatsapp', source_lines: [1] },
    { request: 'File', channel: 'email', source_lines: [1] },
    { request: 'File', channel: 'telegram', source_lines: [] },
  ]) assert.throws(() => parseFileRequests(JSON.stringify({ actions: [action] }), 'Caller: Send it on Telegram.'));
});
