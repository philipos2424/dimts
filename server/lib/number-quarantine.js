/** Fail closed on a misconfigured cooling-off period. */
export function numberQuarantineDays() {
  const days = Number(process.env.NUMBER_QUARANTINE_DAYS ?? 60);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('Invalid NUMBER_QUARANTINE_DAYS');
  return days;
}
