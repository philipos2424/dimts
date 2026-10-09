/**
 * What an uptime monitor needs to know: can Dimts take a call and write its
 * notes right now? `/health` only proves the process is up; this checks the
 * database, the carrier balance, that the AI is configured, and whether calls
 * are failing or stuck in processing. Each check reports on its own, so one
 * failure never hides another.
 */
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { telnyxRequest } from '../lib/telnyx-rest.js';

const LOW_BALANCE_USD = () => Number(process.env.TELNYX_LOW_BALANCE_USD ?? 20);
const FAILED_CALLS_ALERT = () => Number(process.env.FAILED_CALLS_ALERT ?? 3);
// The providers users agree to before their first call (AI_PROVIDERS in
// src/legal.ts). Sending call content anywhere else breaks that consent.
export const DISCLOSED = { llm: 'openai', transcription: 'elevenlabs' };

async function check(name, run) {
  try { return { name, ...(await run()) }; }
  catch (err) { return { name, ok: false, detail: err?.message?.slice(0, 200) ?? 'failed' }; }
}

export const checks = {
  database: () => check('database', async () => {
    await query('SELECT 1');
    return { ok: true };
  }),

  carrier: () => check('carrier', async () => {
    if (config.carrier !== 'telnyx') return { ok: true, detail: `carrier ${config.carrier}, balance not checked` };
    const { balance, currency } = await telnyxRequest('GET', '/balance');
    const amount = Number(balance);
    return { ok: amount >= LOW_BALANCE_USD(), balance: amount, currency,
      ...(amount < LOW_BALANCE_USD() ? { detail: `Telnyx balance ${amount} ${currency} is below ${LOW_BALANCE_USD()}. Top up before calls stop.` } : {}) };
  }),

  ai: () => check('ai', async () => {
    const missing = [];
    if (config.llmProvider === 'openai' && !process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
    if (config.llmProvider === 'ollama' && new URL(config.ollamaBaseUrl).hostname === 'ollama.com' && !process.env.OLLAMA_API_KEY) missing.push('OLLAMA_API_KEY');
    if (config.transcribeProvider === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
    if (config.transcribeProvider === 'whisper' && !process.env.WHISPER_API_TOKEN) missing.push('WHISPER_API_TOKEN');
    const problems = missing.length ? [`Missing ${missing.join(', ')}`] : [];
    if (config.llmProvider !== DISCLOSED.llm || config.transcribeProvider !== DISCLOSED.transcription) {
      problems.push(`Call content goes to ${config.llmProvider}/${config.transcribeProvider}, but users agreed to ${DISCLOSED.llm}/${DISCLOSED.transcription}. Set LLM_PROVIDER=${DISCLOSED.llm} and TRANSCRIBE_PROVIDER=${DISCLOSED.transcription}.`);
    }
    return { ok: !problems.length, llm: config.llmProvider, transcription: config.transcribeProvider,
      ...(problems.length ? { detail: problems.join('; ') } : {}) };
  }),

  calls: () => check('calls', async () => {
    const { rows: [row] } = await query(`SELECT
      count(*) FILTER (WHERE status='processing' AND recording_url IS NOT NULL
        AND COALESCE(processing_until, processing_requested_at + interval '10 minutes') < now() - interval '5 minutes') AS stuck,
      count(*) FILTER (WHERE status='failed' AND COALESCE(completed_at, created_at) > now() - interval '24 hours') AS failed_24h,
      count(*) FILTER (WHERE status='ready' AND COALESCE(completed_at, created_at) > now() - interval '24 hours') AS ready_24h
      FROM calls WHERE deleted_at IS NULL AND created_at > now() - interval '7 days'`);
    const stuck = Number(row.stuck), failed = Number(row.failed_24h), ready = Number(row.ready_24h);
    const problems = [];
    if (stuck) problems.push(`${stuck} call(s) stuck in processing`);
    if (failed >= FAILED_CALLS_ALERT()) problems.push(`${failed} failed call(s) in 24 hours`);
    return { ok: !problems.length, stuck, failed_24h: failed, ready_24h: ready,
      ...(problems.length ? { detail: problems.join('; ') } : {}) };
  }),
};

export async function runHealthChecks() {
  const results = await Promise.all(Object.values(checks).map(run => run()));
  return { ok: results.every(r => r.ok), checked_at: new Date().toISOString(), checks: results };
}
