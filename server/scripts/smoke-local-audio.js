import { readFile, writeFile } from 'node:fs/promises';
import { transcribe } from '../services/transcribe.js';
import { summarize } from '../services/summarize.js';
import { identifyCaller } from '../services/identify.js';

const audio = await readFile(new URL('../../.data/audio-smoke/conversation.wav', import.meta.url));
for (let attempt = 0; attempt < 20; attempt++) {
  try { if ((await fetch('http://127.0.0.1:3104/health')).ok) break; }
  catch { if (attempt === 19) throw new Error('Local Whisper worker is not running'); }
  await new Promise(resolve => setTimeout(resolve, 500));
}
const transcript = await transcribe(new Blob([audio], { type: 'audio/wav' }), { direction: 'outbound' });
if (!transcript.text.includes('User:') || !transcript.text.includes('Caller:')) throw new Error('Speaker labels missing');
const summary = await summarize(transcript.text);
const identity = await identifyCaller(transcript.text);
const result = { transcript: transcript.text, language: transcript.language, summary, identity };
await writeFile(new URL('../../.data/audio-smoke/result.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
