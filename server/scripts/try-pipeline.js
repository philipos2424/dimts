/**
 * Run the AI half of the pipeline against a local audio file.
 *
 *   node --env-file=../.env scripts/try-pipeline.js ./sample.mp3
 *
 * Needs only ELEVENLABS_API_KEY and OPENAI_API_KEY - no Twilio account, no
 * database, no phone call. This exists to answer the three questions the unit
 * tests cannot, because they mock every external service:
 *
 *   1. Is the ElevenLabs auth header actually `xi-api-key`?
 *   2. What shape does Scribe really return, and does our merge handle it?
 *   3. Are the summaries any good?
 *
 * A single-channel file exercises the diarize fallback. To exercise the
 * multichannel path you need a real dual-channel Twilio recording.
 */
import { readFile } from 'node:fs/promises';
import { transcribe } from '../services/transcribe.js';
import { summarize } from '../services/summarize.js';

const path = process.argv[2];

if (!path) {
  console.error('Usage: try-pipeline.js <audio-file>');
  console.error('Any mp3/m4a/wav works - a phone voice memo is fine.');
  process.exit(1);
}

function heading(text) {
  console.log(`\n${'-'.repeat(60)}\n${text}\n${'-'.repeat(60)}`);
}

try {
  const bytes = await readFile(path);
  console.log(`Read ${path} (${(bytes.length / 1024).toFixed(0)} KB)`);

  heading('TRANSCRIBING (ElevenLabs Scribe)');
  const started = Date.now();
  const result = await transcribe(new Blob([bytes]));
  console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`language: ${result.language} (${result.languageProbability})`);
  console.log(`shape:    ${Array.isArray(result.raw?.transcripts) ? 'multichannel' : 'single-channel'}`);
  console.log(`\n${result.text}`);

  if (!result.text.trim()) {
    console.error('\nNo speech found - stopping before the summary.');
    process.exit(1);
  }

  heading('SUMMARISING (OpenAI)');
  const summary = await summarize(result.text);
  console.log(JSON.stringify(summary, null, 2));

  heading('DONE');
  console.log('If the transcript reads correctly and the summary is sensible,');
  console.log('the AI half of the product works. Twilio is the only untested part.');
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  if (String(err.message).includes('401')) {
    console.error('\n401 means the API key or auth header is wrong - which is');
    console.error('exactly one of the assumptions this script exists to check.');
  }
  process.exit(1);
}
