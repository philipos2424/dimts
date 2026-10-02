// This is an operator policy, not a location detector or legal certification.
// Snapshot it on each call so configuration changes cannot rewrite consent.
export function recordingPolicy(env = process.env) {
  const mode = env.RECORDING_CONSENT_MODE || 'all_parties';
  if (!['all_parties', 'owner_only'].includes(mode)) throw new Error('Invalid RECORDING_CONSENT_MODE');
  const scope = env.RECORDING_OWNER_ONLY_APPROVED_SCOPE?.trim() || null;
  if (mode === 'owner_only' && !scope) throw new Error('Set RECORDING_OWNER_ONLY_APPROVED_SCOPE');
  return { mode, scope: mode === 'owner_only' ? scope : null };
}

export function hasRecordingAuthorization(call) {
  if (!call?.record_enabled) return false;
  if ((call.consent_mode ?? 'all_parties') === 'all_parties') return !!(call.parent_consent_at && call.child_consent_at);
  if (call.consent_mode !== 'owner_only' || !call.consent_scope?.trim() || !call.other_party_notice_issued_at) return false;
  return call.direction === 'outbound' ? !!call.parent_consent_at : call.direction === 'inbound' && !!call.child_consent_at;
}

// Keep the atomic SQL guards equivalent to the JavaScript predicate.
export const recordingAuthorizationSql = `(record_enabled AND (
  (consent_mode='all_parties' AND parent_consent_at IS NOT NULL AND child_consent_at IS NOT NULL)
  OR (consent_mode='owner_only' AND length(trim(consent_scope))>0 AND other_party_notice_issued_at IS NOT NULL
    AND ((direction='outbound' AND parent_consent_at IS NOT NULL)
      OR (direction='inbound' AND child_consent_at IS NOT NULL)))))`;
