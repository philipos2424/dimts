/**
 * The providers users agree to before their first call (AI_PROVIDERS in
 * src/legal.ts, App Store guideline 5.1.2(i)). In production, call content
 * must never go anywhere else, so the AI services refuse to send it.
 * The Vercel entry point skips validateDeployment, so the check lives here,
 * at the point where content leaves Dimts.
 */
export const DISCLOSED = { llm: 'openai', transcription: 'elevenlabs' };

export function assertDisclosed(kind, provider, env = process.env) {
  if (env.VERCEL_ENV !== 'production' || provider === DISCLOSED[kind]) return;
  const name = kind === 'llm' ? 'LLM_PROVIDER' : 'TRANSCRIBE_PROVIDER';
  throw new Error(`${name}=${provider} is not a provider users agreed to; set ${name}=${DISCLOSED[kind]}`);
}
