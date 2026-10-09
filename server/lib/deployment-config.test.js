import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeployment } from './deployment-config.js';
const base=()=>({DATABASE_MODE:'postgres',DATABASE_URL:'postgresql://dimts:test-password@db:5432/dimts',
  PUBLIC_BASE_URL:'https://calls.example.com',TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),
  TWILIO_AUTH_TOKEN:'b'.repeat(32),TWILIO_VERIFY_SERVICE_SID:'VA'+'c'.repeat(32),TWILIO_NUMBER:'+15555550999',
  LLM_PROVIDER:'ollama',OLLAMA_BASE_URL:'https://ollama.com',OLLAMA_API_KEY:'test-cloud-key',OLLAMA_MODEL:'gemma4:31b',
  TRANSCRIBE_PROVIDER:'whisper',WHISPER_BASE_URL:'http://whisper:3104',WHISPER_API_TOKEN:'d'.repeat(64),
  DATA_ENCRYPTION_KEYS:`k1:${Buffer.alloc(32,7).toString('base64')}`,AUDIT_SALT:'s'.repeat(32)});

test('accepts the pilot stack and fully configured same-origin Google callbacks',()=>{
  assert.deepEqual(validateDeployment(base()),{host:'0.0.0.0',port:3000});
  assert.equal(validateDeployment({...base(),PORT:'8080',GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret',
    GOOGLE_OAUTH_REDIRECT_URI:'https://calls.example.com/oauth/google/callback',INTEGRATION_ENCRYPTION_KEY:'e'.repeat(64)}).port,8080);
});
test('invalid or incomplete deployment settings fail before service startup, without leaking their values',()=>{
  for(const change of [
    {DATABASE_MODE:'local'},{DATABASE_URL:'not-a-url-secret'},{PUBLIC_BASE_URL:'http://calls.example.com'},
    {PUBLIC_BASE_URL:'https://localhost'},{PUBLIC_BASE_URL:'https://calls.example.com/path'},
    {SKIP_TWILIO_SIGNATURE_CHECK:'true'},{TWILIO_ACCOUNT_SID:'secret-bad-account'},{TWILIO_AUTH_TOKEN:'secret-bad-token'},
    {WHISPER_API_TOKEN:'too-short-secret'},{OLLAMA_BASE_URL:'http://ollama.com'},{OLLAMA_API_KEY:''},
    {TRANSCRIBE_PROVIDER:'unknown'},{LLM_PROVIDER:'unknown'},{PORT:'0'},{CALLS_PER_DAY:'-1'},
    {GOOGLE_OAUTH_CLIENT_ID:'half-configured'},{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret',
      GOOGLE_OAUTH_REDIRECT_URI:'https://other.example/oauth/google/callback',INTEGRATION_ENCRYPTION_KEY:'e'.repeat(64)},
  ]) assert.throws(()=>validateDeployment({...base(),...change}),error=>
    !Object.values(change).some(value=>value.length>10 && error.message.includes(value)));
});
test('optional alternative AI providers require their own credentials',()=>{
  const env={...base(),LLM_PROVIDER:'openai',TRANSCRIBE_PROVIDER:'elevenlabs'};
  assert.throws(()=>validateDeployment(env),/OPENAI_API_KEY/);
  env.OPENAI_API_KEY='test-key';assert.throws(()=>validateDeployment(env),/ELEVENLABS_API_KEY/);
  env.ELEVENLABS_API_KEY='test-key';assert.equal(validateDeployment(env).port,3000);
});

test('production refuses to run without data encryption keys or a private audit salt',()=>{
  for (const [name,value,error] of [['DATA_ENCRYPTION_KEYS',undefined,/Set DATA_ENCRYPTION_KEYS/],
    ['DATA_ENCRYPTION_KEYS','k1:short',/Invalid DATA_ENCRYPTION_KEYS/],['AUDIT_SALT',undefined,/Set AUDIT_SALT/],
    ['AUDIT_SALT','short',/AUDIT_SALT must have/]]) {
    const env={...base()}; if (value===undefined) delete env[name]; else env[name]=value;
    assert.throws(()=>validateDeployment(env),error);
  }
});

test('Sentry is optional but configured DSNs must point to the EU region', () => {
  assert.equal(validateDeployment({ ...base(), SENTRY_DSN: '', EXPO_PUBLIC_SENTRY_DSN: '' }).port, 3000);
  const eu = 'https://abcdef@o123.ingest.de.sentry.io/456';
  assert.equal(validateDeployment({ ...base(), SENTRY_DSN: eu, EXPO_PUBLIC_SENTRY_DSN: eu }).port, 3000);
  for (const name of ['SENTRY_DSN', 'EXPO_PUBLIC_SENTRY_DSN']) {
    assert.throws(() => validateDeployment({ ...base(), [name]: 'https://abcdef@o123.ingest.us.sentry.io/456' }), new RegExp(name));
  }
});
