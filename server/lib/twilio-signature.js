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
  if (config.skipTwilioSignatureCheck) {
    console.warn('[twilio] signature check disabled');
    return next();
  }

  if (!isValidTwilioRequest(req)) {
    console.warn('[twilio] rejected unsigned request', req.originalUrl);
    return res.status(403).type('text/plain').send('Invalid Twilio signature');
  }

  return next();
}
