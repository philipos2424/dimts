import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingQualityError } from './recording-quality.js';

test('silent, mono and missing signal cannot generate confident AI notes', () => {
  for (const status of ['silent', 'single_channel', 'missing_channel_signal']) {
    assert.match(recordingQualityError({ audio_quality: { status } }), /AI notes were not generated/);
  }
});
test('both channel transcripts are required when the provider separates channels', () => {
  assert.match(recordingQualityError({ transcripts: [{ text: 'Hello' }, { text: ' ' }] }), /both recording channels/);
  assert.match(recordingQualityError({ transcripts: [{ text: 'Hello' }] }), /both recording channels/);
  assert.equal(recordingQualityError({ transcripts: [{ text: 'Hello' }, { text: 'Hi' }], audio_quality: { status: 'signal_present' } }), null);
  assert.equal(recordingQualityError({ text: 'Legacy provider text' }), null);
});
