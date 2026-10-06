import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeMultiChannel,
  normalizeScribeResponse,
  sequentialTranscript,
} from './transcribe.js';

const multichannel = {
  transcripts: [
    {
      language_code: 'amh',
      language_probability: 0.97,
      text: 'ሰላም ነው',
      words: [
        { text: 'ሰላም', type: 'word', start: 0.2, end: 0.6 },
        { text: 'ነው', type: 'word', start: 0.7, end: 1.0 },
      ],
    },
    {
      language_code: 'amh',
      language_probability: 0.91,
      text: 'እሺ አመሰግናለሁ',
      words: [
        { text: 'እሺ', type: 'word', start: 1.4, end: 1.8 },
        { text: 'አመሰግናለሁ', type: 'word', start: 1.9, end: 2.6 },
      ],
    },
  ],
};

test('merges channels into speaker-labelled turns ordered by time', () => {
  const merged = mergeMultiChannel(multichannel.transcripts);
  assert.equal(merged, 'User: ሰላም ነው\nCaller: እሺ አመሰግናለሁ');
});

test('orders turns by start time, not by channel index', () => {
  const merged = mergeMultiChannel([
    { words: [{ text: 'second', type: 'word', start: 5 }] },
    { words: [{ text: 'first', type: 'word', start: 1 }] },
  ]);
  assert.equal(merged, 'Caller: first\nUser: second');
});

test('preserves alternating dialogue across the entire conversation', () => {
  assert.equal(mergeMultiChannel([
    { words: [{ text: 'Hello', start: 0 }, { text: 'Yes', start: 3 }] },
    { words: [{ text: 'Tomorrow?', start: 2 }, { text: 'Great', start: 4 }] },
  ]), 'User: Hello\nCaller: Tomorrow?\nUser: Yes\nCaller: Great');
});

test('maps the incoming parent channel to Caller', () => {
  const result = normalizeScribeResponse(multichannel, { direction: 'inbound' });
  assert.equal(result.text, 'Caller: ሰላም ነው\nUser: እሺ አመሰግናለሁ');
});

test('uses whole channel text rather than fabricating missing timings', () => {
  assert.equal(mergeMultiChannel([
    { text: 'Hello again', words: [{ text: 'Hello' }] },
    { text: 'Hi', words: [{ text: 'Hi', start: 1 }] },
  ]), 'User: Hello again\nCaller: Hi');
});

test('does not append audio events to speech', () => {
  assert.equal(mergeMultiChannel([{ words: [
    { text: 'Hello', type: 'word', start: 0 },
    { text: '(laughs)', type: 'audio_event', start: 1 },
    { text: 'again', type: 'word', start: 2 },
  ] }]), 'User: Hello again');
});

test('falls back to channel text when word timings are absent', () => {
  const merged = mergeMultiChannel([{ text: 'no timings here', words: [] }]);
  assert.equal(merged, 'User: no timings here');
});

test('ignores non-word tokens as speaker turns', () => {
  const merged = mergeMultiChannel([
    { words: [{ text: '(laughs)', type: 'audio_event', start: 0.1 }] },
  ]);
  assert.equal(merged, '');
});

test('normalizes a multichannel response', () => {
  const result = normalizeScribeResponse(multichannel);
  assert.equal(result.language, 'amh');
  assert.equal(result.languageProbability, 0.97);
  assert.match(result.text, /^User: ሰላም ነው/);
  assert.equal(result.raw, multichannel);
});

test('normalizes a single-channel (diarize fallback) response', () => {
  const single = {
    language_code: 'eng',
    language_probability: 0.88,
    text: 'Hello there.',
    words: [{ text: 'Hello', type: 'word', start: 0 }],
  };

  const result = normalizeScribeResponse(single);
  assert.equal(result.text, 'Hello there.');
  assert.equal(result.language, 'eng');
  assert.equal(result.languageProbability, 0.88);
});

test('treats an empty transcripts array as single-channel', () => {
  const result = normalizeScribeResponse({ transcripts: [], text: 'fallback' });
  assert.equal(result.text, 'fallback');
});

test('sequentialTranscript keeps channels whole for scrambled timelines', () => {
  assert.equal(
    sequentialTranscript(multichannel.transcripts),
    'User: ሰላም ነው\nCaller: እሺ አመሰግናለሁ'
  );
});

test('a voicemail is one caller on one channel, whatever shape the provider returns', () => {
  assert.equal(normalizeScribeResponse({ text: ' Please call me back. ', language_code: 'en' }, { voicemail: true }).text, 'Caller: Please call me back.');
  assert.equal(normalizeScribeResponse({ transcripts: [{ text: 'Selam' }] }, { voicemail: true }).text, 'Caller: Selam');
  assert.equal(normalizeScribeResponse({ text: '   ' }, { voicemail: true }).text, '');
});

test('reads the channel count from an MP3 frame header, after an ID3 tag', async () => {
  const { mp3Channels } = await import('./transcribe.js');
  const frame = (mode) => [0xff, 0xfb, 0x90, mode << 6];
  assert.equal(mp3Channels(Uint8Array.from(frame(3))), 1, 'mono');
  assert.equal(mp3Channels(Uint8Array.from(frame(1))), 2, 'joint stereo');
  const id3 = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 0, 0];
  assert.equal(mp3Channels(Uint8Array.from([...id3, ...frame(3)])), 1);
  assert.equal(mp3Channels(Uint8Array.from([1, 2, 3, 4, 5])), null);
});

test('keyterms include the owner contacts, within ElevenLabs limits; birr only on calls with Ethiopia', async () => {
  const { keytermsFor } = await import('./transcribe.js');
  assert.ok(!keytermsFor(['Dave'], ['+14155550100', '+447700900123']).includes('birr'));
  const terms = keytermsFor(['Abebe Kebede', '  Tigist  ', 'Abebe Kebede', 'a{bad}', 'x'.repeat(60), 'one two three four five six', null],
    ['+14155550100', '+251911234567']);
  assert.ok(terms.includes('birr') && terms.includes('ብር'));
  assert.ok(terms.includes('Abebe Kebede') && terms.includes('Tigist'));
  assert.equal(terms.filter(t => t === 'Abebe Kebede').length, 1);
  assert.ok(!terms.some(t => t.includes('{') || t.length >= 50 || t.split(' ').length > 5));
});
