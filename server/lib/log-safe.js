// Vercel keeps function logs outside the EU database's protections, so phone
// numbers never reach them: Postgres errors quote row values ("Key (phone)=…")
// and provider errors echo request bodies.
const PHONE = /\+?[1-9]\d{6,14}\b/g;

export const maskPhones = text => String(text).replace(PHONE, match => `…${match.slice(-2)}`);

/** An error as one loggable line with phone numbers masked. */
export function safeError(err) {
  if (!(err instanceof Error)) return maskPhones(err);
  const detail = err.detail ? ` (${err.detail})` : '';
  return maskPhones(`${err.stack ?? `${err.name}: ${err.message}`}${detail}`);
}
