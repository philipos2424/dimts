/**
 * The providers users agree to before their first call (AI_PROVIDERS in
 * src/legal.ts, App Store guideline 5.1.2(i)). In production, call content
 * must never go anywhere else, so the AI services refuse to send it.
 * The Vercel entry point skips validateDeployment, so the check lives here,
 * at the point where content leaves Dimts. A base-URL override must point at
 * the same provider (its EU endpoint), never at another host.
 */
export const DISCLOSED = { llm: 'openai', transcription: 'elevenlabs' };

const DESTINATIONS = {
  llm: { env: 'OPENAI_BASE_URL', origins: ['https://api.openai.com', 'https://eu.api.openai.com'] },
  transcription: { env: 'ELEVENLABS_BASE_URL', origins: ['https://api.elevenlabs.io', 'https://api.eu.residency.elevenlabs.io'] },
};

// Vercel says which environment it is; elsewhere (Docker) NODE_ENV does.
const isProduction = env => env.VERCEL_ENV ? env.VERCEL_ENV === 'production' : env.NODE_ENV === 'production';

export function assertDisclosed(kind, provider, env = process.env) {
  if (!isProduction(env)) return;
  const name = kind === 'llm' ? 'LLM_PROVIDER' : 'TRANSCRIBE_PROVIDER';
  if (provider !== DISCLOSED[kind]) throw new Error(`${name}=${provider} is not a provider users agreed to; set ${name}=${DISCLOSED[kind]}`);
  const { env: urlName, origins } = DESTINATIONS[kind];
  if (!env[urlName]) return;
  let origin;
  try { origin = new URL(env[urlName]).origin; } catch { origin = null; }
  if (!origins.includes(origin)) throw new Error(`${urlName} must be one of ${origins.join(', ')}`);
}
