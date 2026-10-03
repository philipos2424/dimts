import test from 'node:test';
import assert from 'node:assert/strict';
import { captureState } from './today.js';
import { recordingQualityError, voicemailQualityError } from './recording-quality.js';

test('a processed voicemail is labelled as a message, not as both voices', () => {
  assert.equal(captureState({ status: 'ready', voicemail: true, has_audio: true }), 'voicemail');
  assert.equal(captureState({ status: 'ready', has_audio: true }), 'both');
  assert.equal(captureState({ status: 'processing', voicemail: true, has_audio: true }), 'pending');
});

test('a single-channel voicemail is valid; only silence fails it', () => {
  const mono = { audio_quality: { status: 'single_channel' } };
  assert.ok(recordingQualityError(mono));
  assert.equal(voicemailQualityError(mono), null);
  assert.ok(voicemailQualityError({ audio_quality: { status: 'silent' } }));
});
