/**
 * Whether an incoming call is recorded. A per-caller choice wins; otherwise the
 * owner's default decides: 'all' records every caller (the original behaviour),
 * 'chosen' records only callers the owner marked Record.
 * Skipping never weakens consent: an unrecorded call plays no notice and stores no audio.
 */
export function shouldRecordIncoming(user, contact) {
  const pref = contact?.recording_pref;
  if (pref === 'record') return true;
  if (pref === 'skip') return false;
  return (user?.incoming_recording ?? 'all') !== 'chosen';
}
