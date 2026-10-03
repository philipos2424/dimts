import { createPublicKey, verify } from 'node:crypto';
import twilio from 'twilio';
import { config } from '../config.js';

/**
 * Rebuild the URL Twilio signed.
 *
 * Twilio computes the HMAC over the exact public URL it requested. Behind
 * ngrok or a Vercel Function, `req.protocol` and `req.host` describe the
 * *internal* hop, so deriving the URL from the request reproduces something
 * Twilio never signed and validation fails for every single webhook. Anchoring
 * on PUBLIC_BASE_URL is what makes this work in both environments.
 */
export function signedUrlFor(req) {
  return config.publicBaseUrl + req.originalUrl;
}

// DER prefix that turns a raw 32-byte Ed25519 public key into SPKI.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_SKEW_SECONDS = 300;

/** Telnyx: Ed25519 over `${timestamp}|${raw body}`, with a replay window. */
export function isValidTelnyxRequest(req, now = Date.now()) {
  const signature = req.get('telnyx-signature-ed25519');
  const timestamp = req.get('telnyx-timestamp');
  if (!signature || !/^\d{9,11}$/.test(timestamp ?? '')) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  try {
    const raw = Buffer.from(config.telnyxPublicKey, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
    const payload = Buffer.concat([Buffer.from(`${timestamp}|`), req.rawBody ?? Buffer.alloc(0)]);
    return verify(null, payload, key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

export function isValidTwilioRequest(req) {
  const signature = req.get('X-Twilio-Signature');
  if (!signature) return false;

  return twilio.validateRequest(
    config.twilioAuthToken,
    signature,
    signedUrlFor(req),
    req.body ?? {}
  );
}

/**
 * Rejects forged webhook traffic. These endpoints mutate call rows and trigger
 * paid API calls, so they are not safe to leave open.
 */
export function verifyTwilioSignature(req, res, next) {
  // Vercel production never runs validateDeployment, so the refusal lives here too.
  if (config.skipTwilioSignatureCheck && process.env.VERCEL_ENV !== 'production') {
    console.warn('[twilio] signature check disabled');
    return next();
  }
  if (config.skipTwilioSignatureCheck) console.error('[twilio] SKIP_TWILIO_SIGNATURE_CHECK ignored in production');

  const valid = config.carrier === 'telnyx' ? isValidTelnyxRequest(req) : isValidTwilioRequest(req);
  if (!valid) {
    console.warn('[twilio] rejected unsigned request', req.originalUrl);
    return res.status(403).type('text/plain').send('Invalid webhook signature');
  }

  return next();
}
