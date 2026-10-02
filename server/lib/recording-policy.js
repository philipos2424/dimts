// Every new call records under one rule: the owner accepted the terms once,
// and the other person hears a notice before the conversation. Historic calls
// keep the mode they were snapshotted with, so their checks below remain.
export function recordingPolicy(_env = process.env) {
  return { mode: 'notice', scope: null };
}

export function hasRecordingAuthorization(call) {
  if (!call?.record_enabled) return false;
  if (call.consent_mode === 'notice') return !!call.other_party_notice_issued_at &&
    (call.direction === 'outbound' ? !!call.parent_consent_at : call.direction === 'inbound' && !!call.child_consent_at);
  if ((call.consent_mode ?? 'all_parties') === 'all_parties') return !!(call.parent_consent_at && call.child_consent_at);
  if (call.consent_mode !== 'owner_only' || !call.consent_scope?.trim() || !call.other_party_notice_issued_at) return false;
  return call.direction === 'outbound' ? !!call.parent_consent_at : call.direction === 'inbound' && !!call.child_consent_at;
}

// Keep the atomic SQL guards equivalent to the JavaScript predicate.
export const recordingAuthorizationSql = `(record_enabled AND (
  (consent_mode='notice' AND other_party_notice_issued_at IS NOT NULL
    AND ((direction='outbound' AND parent_consent_at IS NOT NULL)
      OR (direction='inbound' AND child_consent_at IS NOT NULL)))
  OR (consent_mode='all_parties' AND parent_consent_at IS NOT NULL AND child_consent_at IS NOT NULL)
  OR (consent_mode='owner_only' AND length(trim(consent_scope))>0 AND other_party_notice_issued_at IS NOT NULL
    AND ((direction='outbound' AND parent_consent_at IS NOT NULL)
      OR (direction='inbound' AND child_consent_at IS NOT NULL)))))`;
