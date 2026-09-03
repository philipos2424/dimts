/**
 * Phone handling. Twilio always delivers E.164 in `From` and `To`, so this
 * deliberately does not pull in libphonenumber - normalisation only has to
 * survive human-entered numbers from onboarding.
 */

export function isE164(value) {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
}

/** Returns a dialable E.164 string, or null when the input is not one. */
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;

  const stripped = value.replace(/[\s()\-.]/g, '');
  return isE164(stripped) ? stripped : null;
}
