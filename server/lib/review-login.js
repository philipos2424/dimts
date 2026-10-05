/**
 * App Store and Play reviewers cannot receive a text, so one number may sign
 * in with a fixed code. Off unless both settings exist; the code must be long
 * enough that the per-number rate limit makes guessing it hopeless.
 */
export function reviewLogin() {
  const phone = process.env.REVIEW_PHONE?.trim(), code = process.env.REVIEW_CODE?.trim();
  return phone && /^\d{8,}$/.test(code ?? '') ? { phone, code } : null;
}
