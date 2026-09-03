/**
 * Environment configuration.
 *
 * Values are read lazily through `requireEnv` so that importing this module in
 * tests (or in a partially-configured deployment) does not blow up; the throw
 * happens at the point of use, naming the variable that is actually missing.
 */

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`
    );
  }
  return value;
}

export const config = {
  get twilioAccountSid() {
    return requireEnv('TWILIO_ACCOUNT_SID');
  },
  get twilioAuthToken() {
    return requireEnv('TWILIO_AUTH_TOKEN');
  },
  get twilioNumber() {
    return requireEnv('TWILIO_NUMBER');
  },
  get elevenLabsApiKey() {
    return requireEnv('ELEVENLABS_API_KEY');
  },
  get openaiApiKey() {
    return requireEnv('OPENAI_API_KEY');
  },
  get databaseUrl() {
    return requireEnv('DATABASE_URL');
  },

  /** Public origin Twilio calls back on. Never has a trailing slash. */
  get publicBaseUrl() {
    return requireEnv('PUBLIC_BASE_URL').replace(/\/+$/, '');
  },

  /**
   * ElevenLabs Scribe model. SPEC.md names scribe_v1, but the current docs
   * only list Scribe v2, so v2 is the default. One line to flip back.
   */
  scribeModelId: process.env.SCRIBE_MODEL_ID || 'scribe_v2',

  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  /**
   * Roughly a dozen US states require all-party consent to record. Users are
   * recording customers, so this is on unless explicitly disabled.
   */
  get announceRecording() {
    return process.env.ANNOUNCE_RECORDING !== 'false';
  },

  get recordingNotice() {
    return (
      process.env.RECORDING_NOTICE ??
      'This call may be recorded and transcribed for note taking.'
    );
  },

  /**
   * Skipping signature checks makes every webhook forgeable. Only ever set
   * this for local replay of captured payloads.
   */
  skipTwilioSignatureCheck: process.env.SKIP_TWILIO_SIGNATURE_CHECK === 'true',

  /** Rows stuck before answer longer than this are reaped as failed. */
  staleCallMinutes: 10,
};

/** True when running inside a Vercel Function rather than a long-lived process. */
export const isServerless = Boolean(process.env.VERCEL);
