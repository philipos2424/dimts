// Opt-in provider check using synthetic speech, never customer recordings.
import { readFile } from 'node:fs/promises';
import { transcribe } from '../services/transcribe.js';
import { summarize } from '../services/summarize.js';
import { identifyCaller } from '../services/identify.js';

if (process.env.AI_SMOKE_ON_BUILD === '1') {
  let stage = 'transcription';
  try {
    const bytes = await readFile(new URL('../fixtures/ai-smoke.wav', import.meta.url));
    const transcript = await transcribe(new Blob([bytes], { type: 'audio/wav' }), { direction: 'outbound' });
    console.log('[ai-smoke] transcript checks:', JSON.stringify({
      user: /^User:/m.test(transcript.text), caller: /^Caller:/m.test(transcript.text),
      name: /Alex/i.test(transcript.text), proposal: /proposal/i.test(transcript.text),
    }));
    if (!/^User:/m.test(transcript.text) || !/^Caller:/m.test(transcript.text) ||
        !/Alex/i.test(transcript.text) || !/proposal/i.test(transcript.text)) {
      throw new Error('Synthetic transcript did not preserve both speakers and expected facts');
    }
    console.log('[ai-smoke] transcription passed: both speakers and expected facts');
    stage = 'summary';
    const report = await summarize(transcript.text);
    if (!/Alex/i.test(report.summary) || !/meet/i.test(report.summary) ||
        !report.action_items.some(item => item.owner === 'Caller' && /proposal/i.test(item.task))) {
      throw new Error('Synthetic summary lost the meeting or caller commitment');
    }
    console.log('[ai-smoke] summary passed: meeting and caller-owned commitment');
    stage = 'identity';
    const identity = await identifyCaller(transcript.text);
    if (!/^Alex$/i.test(identity.name ?? '') || !/Demo/i.test(identity.company ?? '') || identity.confidence <= 0.7) {
      throw new Error('Synthetic introduction was not identified');
    }
    console.log('[ai-smoke] identity passed: explicit caller introduction');
  } catch (error) {
    // Provider bodies and model output can contain private data: never log them.
    const status = String(error?.message ?? '').match(/(?:HTTP |ElevenLabs )(\d{3})/)?.[1];
    const missing = String(error?.message ?? '').match(/^Missing required environment variable (ELEVENLABS_API_KEY|WHISPER_BASE_URL|WHISPER_API_TOKEN)\./)?.[1];
    if (missing) console.error(`[ai-smoke] missing ${missing}`);
    if (['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name)) console.error(`[ai-smoke] ${error.name}`);
    console.error(`[ai-smoke] ${stage} failed${status ? ` (HTTP ${status})` : ''}`);
    process.exitCode = 1;
  }
} else {
  console.log('[ai-smoke] skipped (opt-in check)');
}
