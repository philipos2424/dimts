import { config } from '../config.js';
import { telnyxRequest } from '../lib/telnyx-rest.js';
import { HttpError } from '../lib/users.js';

/**
 * Carriers only let an account present numbers it owns or has verified.
 * Telnyx verifies by calling or texting the number with a code.
 */
function requireTelnyx() {
  if (config.carrier !== 'telnyx') throw new HttpError(409, 'caller_id_unavailable', 'Showing your own number needs the Telnyx carrier.');
}

export async function startCallerIdVerification(phone, method = 'call') {
  requireTelnyx();
  try {
    await telnyxRequest('POST', '/verified_numbers', {
      json: { phone_number: phone, verification_method: method === 'sms' ? 'sms' : 'call' }, timeout: 15_000,
    });
  } catch (err) {
    // Already verified on this carrier account: nothing to send.
    if (err.status === 409 || /already/i.test(err.message)) return { alreadyVerified: true };
    if (err.status === 422 || err.status === 403) throw new HttpError(422, 'caller_id_rejected', 'The carrier cannot verify this number. Check it can receive calls.');
    throw err;
  }
  return { alreadyVerified: false };
}

export async function confirmCallerId(phone, code) {
  requireTelnyx();
  try {
    await telnyxRequest('POST', `/verified_numbers/${encodeURIComponent(phone)}/actions/verify`, {
      json: { verification_code: code }, timeout: 15_000,
    });
    return true;
  } catch (err) {
    if (err.status === 400 || err.status === 404 || err.status === 422) return false;
    throw err;
  }
}
