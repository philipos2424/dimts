import { isE164 } from './phone.js';

// Validate before listening or migrating. Error messages name settings only;
// never include database URLs, tokens or other configured values.
export function validateDeployment(env = process.env) {
  const required = name => { if (!env[name]?.trim()) throw new Error(`Set ${name}`); return env[name]; };
  const match = (name, pattern) => { if (!pattern.test(required(name))) throw new Error(`Invalid ${name}`); };
  function url(name, protocols) {
    let result; try { result = new URL(required(name)); } catch { throw new Error(`Invalid ${name}`); }
    if (!protocols.includes(result.protocol) || result.username || result.password || result.hash) throw new Error(`Invalid ${name}`);
    return result;
  }
  if (env.DATABASE_MODE !== 'postgres') throw new Error('Production requires DATABASE_MODE=postgres');
  let database; try { database = new URL(required('DATABASE_URL')); } catch { throw new Error('Invalid DATABASE_URL'); }
  if (!['postgres:','postgresql:'].includes(database.protocol)) throw new Error('Invalid DATABASE_URL');
  const origin = url('PUBLIC_BASE_URL',['https:']);
  if (origin.pathname !== '/' || origin.search || /^(localhost|127\.|0\.|\[::1\])/i.test(origin.hostname)) throw new Error('Invalid PUBLIC_BASE_URL');
  if (env.SKIP_TWILIO_SIGNATURE_CHECK === 'true') throw new Error('Production requires Twilio signature checks');
  match('TWILIO_ACCOUNT_SID',/^AC[a-f0-9]{32}$/i);
  match('TWILIO_AUTH_TOKEN',/^[a-f0-9]{32}$/i);
  match('TWILIO_VERIFY_SERVICE_SID',/^VA[a-f0-9]{32}$/i);
  if (!isE164(required('TWILIO_NUMBER'))) throw new Error('Invalid TWILIO_NUMBER');
  const llm = env.LLM_PROVIDER || 'ollama';
  if (llm === 'ollama') {
    const ollama = url('OLLAMA_BASE_URL',['http:','https:']);
    required('OLLAMA_MODEL');
    if (ollama.hostname === 'ollama.com') {
      if (ollama.protocol !== 'https:') throw new Error('Ollama Cloud requires HTTPS');
      required('OLLAMA_API_KEY');
    }
  } else if (llm === 'openai') required('OPENAI_API_KEY');
  else throw new Error('Invalid LLM_PROVIDER');
  const transcriber = env.TRANSCRIBE_PROVIDER || 'whisper';
  if (transcriber === 'whisper') {
    url('WHISPER_BASE_URL',['http:','https:']);
    if (required('WHISPER_API_TOKEN').length < 32) throw new Error('WHISPER_API_TOKEN must have at least 32 characters');
  } else if (transcriber === 'elevenlabs') required('ELEVENLABS_API_KEY');
  else throw new Error('Invalid TRANSCRIBE_PROVIDER');
  if (env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_OAUTH_REDIRECT_URI) {
    required('GOOGLE_OAUTH_CLIENT_ID'); required('GOOGLE_OAUTH_CLIENT_SECRET');
    match('INTEGRATION_ENCRYPTION_KEY',/^[a-f0-9]{64}$/i);
    const redirect = url('GOOGLE_OAUTH_REDIRECT_URI',['https:']);
    if (redirect.origin !== origin.origin || redirect.pathname !== '/oauth/google/callback' || redirect.search) throw new Error('Invalid GOOGLE_OAUTH_REDIRECT_URI');
  }
  for (const name of ['CALLS_PER_DAY','CALL_MINUTES_PER_MONTH','GLOBAL_CALL_MINUTES_PER_MONTH']) {
    if (env[name] != null && (!Number.isSafeInteger(Number(env[name])) || Number(env[name]) <= 0)) throw new Error(`Invalid ${name}`);
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return { port, host: '0.0.0.0' };
}
