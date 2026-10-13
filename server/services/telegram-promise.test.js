import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsTelegram, parseTelegramPromise } from './telegram-promise.js';
import { signWebhook, verifyWebhook } from '../lib/standard-webhooks.js';

const transcript = [
  'Caller: How much is a bag of cement now?',
  'User: It is 1,450 birr. I will send you the full price list on Telegram after this call.',
  'Caller: Great, thanks.',
].join('\n');

const answer = (over = {}) => JSON.stringify({
  promised: true, request: 'cement price list', draft: 'Hi, here is our price list as promised.',
  evidence: { source_lines: [2], confidence: 0.9 }, ...over,
});

test('mentionsTelegram catches spellings and Amharic, and ignores other calls', () => {
  assert.equal(mentionsTelegram('I will telegram it'), true);
  assert.equal(mentionsTelegram('send on Telegaram please'), true);
  assert.equal(mentionsTelegram('በቴሌግራም እልክልሃለሁ'), true);
  assert.equal(mentionsTelegram('I will email you the quote'), false);
  assert.equal(mentionsTelegram(null), false);
});

test('a User promise quoted from the transcript is accepted', () => {
  const result = parseTelegramPromise(answer(), transcript);
  assert.equal(result.request, 'cement price list');
  assert.deepEqual(result.evidence.quotes, [transcript.split('\n')[1]]);
});

test('nothing is sent without a real, confident User promise about Telegram', () => {
  assert.equal(parseTelegramPromise(answer({ promised: false }), transcript), null);
  assert.equal(parseTelegramPromise(answer({ evidence: { source_lines: [1], confidence: 0.9 } }), transcript), null, 'Caller line');
  assert.equal(parseTelegramPromise(answer({ evidence: { source_lines: [2], confidence: 0.5 } }), transcript), null, 'low confidence');
  assert.equal(parseTelegramPromise(answer({ evidence: { source_lines: [9], confidence: 0.9 } }), transcript), null, 'line out of range');
  assert.equal(parseTelegramPromise(answer({ draft: '' }), transcript), null);
  const noTelegram = transcript.replace('on Telegram ', '');
  assert.equal(parseTelegramPromise(answer(), noTelegram), null, 'quoted line must mention Telegram');
});

test('MiniMe requests are signed in the format Dimts verifies', () => {
  const body = Buffer.from('{"type":"send"}');
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = signWebhook('shared-secret', 'msg_1', ts, body);
  assert.doesNotThrow(() => verifyWebhook({ body, id: 'msg_1', timestamp: ts, signature }, 'shared-secret'));
  assert.throws(() => verifyWebhook({ body, id: 'msg_1', timestamp: ts, signature }, 'other-secret'));
});
