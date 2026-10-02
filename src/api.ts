import type { Key } from './i18n';
import { Platform } from 'react-native';

const BASE = Platform.OS === 'web' ? '' : (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');
let sessionToken: string | null = null;
export function setApiSession(token: string | null) { sessionToken = token; }
export function captureSessionGuard() { const current = sessionToken; return () => current !== null && current === sessionToken; }

export type CallSummary = {
  id: string;
  destination: string;
  contact_name: string | null;
  company: string | null;
  direction: 'inbound' | 'outbound';
  status: string;
  duration_sec: number | null;
  summary: string | null;
  created_at: string;
};

export type ActionItem = { task: string; owner: string | null };
export type ContactContext = {
  contact: { id: string; phone: string; display_name: string | null; company: string | null; notes: string | null } | null;
  previous_calls: { id: string; created_at: string; direction: string; summary: string;
    key_points: string[] | null; action_items: ActionItem[] | null; next_moves: string[] | null }[];
};
export function getCallContext(id: string) {
  return request<ContactContext>(`/api/calls/${id}/context`, '');
}
export function getContactContext(phone: string) {
  return request<ContactContext>(`/api/contacts/context?phone=${encodeURIComponent(phone)}`, '');
}
export function getActiveIncoming() {
  return request<{ call: { id: string; destination: string; status: string; created_at: string } | null }>('/api/calls/incoming/active', '');
}
export type Followups = {
  source_hash?: string;
  version?: number;
  email: ({ subject: string; body: string; recipient: string } & ProposalMetadata) | null;
  meeting: ({ title: string; notes: string; time_text: string; start: string; end: string } & ProposalMetadata) | null;
};
export type CalendarAction = {
  id: string; status: 'pending' | 'confirmed' | 'unknown' | 'failed'; event_id: string | null;
  event_url: string | null; error_code: string | null; proposal_version: number; updated_at: string;
  meeting: NonNullable<Followups['meeting']>;
};
export function getCalendarAction(id: string) {
  return request<{ action: CalendarAction | null }>(`/api/calls/${id}/followups/meeting/action`, '');
}
export function bookReviewedMeeting(id: string, version: number) {
  return request<{ action: CalendarAction }>(`/api/calls/${id}/followups/meeting/action`, '', { method: 'POST', body: JSON.stringify({ version }) });
}
export function reconcileMeeting(id: string) {
  return request<{ action: CalendarAction }>(`/api/calls/${id}/followups/meeting/action/reconcile`, '', { method: 'POST' });
}
export type EmailAction = {
  id: string; status: 'pending' | 'confirmed' | 'unknown' | 'failed'; draft_id: string | null;
  error_code: string | null; proposal_version: number; updated_at: string; email: NonNullable<Followups['email']>;
};
export function getEmailAction(id: string) {
  return request<{ action: EmailAction | null }>(`/api/calls/${id}/followups/email/action`, '');
}
export function createReviewedEmailDraft(id: string, version: number) {
  return request<{ action: EmailAction }>(`/api/calls/${id}/followups/email/action`, '', { method: 'POST', body: JSON.stringify({ version }) });
}
export function reconcileEmail(id: string) {
  return request<{ action: EmailAction }>(`/api/calls/${id}/followups/email/action/reconcile`, '', { method: 'POST' });
}
type ProposalMetadata = { status?: 'pending' | 'rejected'; evidence?: {
  quotes: string[]; confidence: number; reason: string;
} | null };
export function rejectFollowup(id: string, kind: 'email' | 'meeting', version = 0) {
  return request<Followups>(`/api/calls/${id}/followups/${kind}/reject`, '', { method: 'POST', body: JSON.stringify({ version }) });
}
export type FollowupEvent = { kind: string; version: number; created_at: string };
export function getFollowupEvents(id: string) {
  return request<{ events: FollowupEvent[] }>(`/api/calls/${id}/followups/events`, '').then(r => r.events);
}
export function generateFollowups(id: string) {
  return request<Followups>(`/api/calls/${id}/followups`, '', { method: 'POST' });
}
export function refreshFollowups(id: string, version: number) {
  return request<Followups>(`/api/calls/${id}/followups/refresh`, '', { method: 'POST', body: JSON.stringify({ version }) });
}
export function saveFollowups(id: string, draft: Followups) {
  return request<Followups>(`/api/calls/${id}/followups`, '', { method: 'PATCH', body: JSON.stringify(draft) });
}

export type CallDetail = CallSummary & {
  deleted_at: string | null;
  provider_deletion_status: DeletionRecord['provider_deletion_status'];
  provider_deletion_error: string | null;
  provider_deleted_at: string | null;
  record_enabled: boolean;
  parent_consent_at: string | null;
  child_consent_at: string | null;
  consent_mode: 'all_parties' | 'owner_only';
  recording_authorized: boolean;
  other_party_notice_issued_at: string | null;
  recording_start_status: 'pending' | 'started' | 'unknown' | 'failed' | null;
  recording_url: string | null;
  audio_url: string | null;
  transcript: string | null;
  transcript_turns?: { start: number; end: number | null; speaker: string; text: string }[];
  next_moves: string[] | null;
  action_items: ActionItem[] | null;
  key_points: string[] | null;
  error: string | null;
  followups: Followups | null;
};

export type Usage = { month: string; tier: string; minutes_used: number };

/** Carries an i18n key so callers can surface the failure in either language. */
export class ApiError extends Error {
  messageKey: Key;
  status?: number;
  constructor(messageKey: Key, detail?: string, status?: number) {
    super(detail ?? messageKey);
    this.messageKey = messageKey;
    this.status = status;
  }
}

export function audioUrlFor(callId: string): string {
  return `${BASE}/api/calls/${callId}/audio`;
}

/** expo-audio's AudioSource accepts headers, so the proxy stays authenticated. */
export function authHeaders(userPhone: string): Record<string, string> {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

export function sendLoginCode(phone: string) {
  return request('/api/auth/start', '', { method: 'POST', body: JSON.stringify({ phone }) });
}
export function verifyLoginCode(phone: string, code: string) {
  return request<{ token: string; phone: string }>('/api/auth/verify', '', {
    method: 'POST', body: JSON.stringify({ phone, code }),
  });
}
export function getMe() {
  return request<{ phone: string; tier: string; agent_number: string | null }>('/api/me', '');
}
export function claimBusinessNumber() {
  return request<{ agent_number: string }>('/api/me/number', '', { method: 'POST' });
}
export function logout() {
  return request('/api/auth/logout', '', { method: 'POST' });
}
export type GoogleKind = 'calendar' | 'gmail';
export type GoogleStatus = { configured: boolean; connections: { kind: GoogleKind; connected_at: string }[] };
export function getGoogleStatus() { return request<GoogleStatus>('/api/integrations/google', ''); }
export function startGoogleConnection(kind: GoogleKind) {
  return request<{ url: string }>('/api/integrations/google/start', '', { method: 'POST', body: JSON.stringify({ kind }) });
}
export function confirmGoogleConnection(code: string) {
  return request('/api/integrations/google/confirm', '', { method: 'POST', body: JSON.stringify({ code }) });
}
export function disconnectGoogle(kind: GoogleKind) {
  return request(`/api/integrations/google/${kind}`, '', { method: 'DELETE' });
}

function publicErrorMessage(status: number, body: string): string {
  // Only map known error codes. Never display raw provider responses or a
  // server's arbitrary message (which may contain private configuration).
  let code = '';
  try { if (body.length <= 4096) code = JSON.parse(body)?.error; } catch { /* non-JSON error */ }
  if (status >= 500) return 'Dimts could not complete this request. Please try again shortly.';
  const messages: Record<string, string> = {
    invalid_phone: 'Enter a mobile number with its country code, starting with +.',
    handset_required: 'Use the mobile number you will answer, not the Dimts business number.',
    invalid_code: 'That verification code is incorrect or expired. Request another code and try again.',
    invalid_verification: 'Check your phone number and verification code, then try again.',
    verification_trial_number_required: 'This pilot uses a Twilio trial account. Verify this mobile number in Twilio first, or use a verified test number.',
    verification_country_disabled: 'Verification messages are not enabled for this country. The operator needs to check Twilio Verify geographic permissions.',
    destination_trial_number_required: 'The other phone must be verified in this Twilio trial account. Add it under Verified Caller IDs, then try again. No call was started.',
    handset_trial_number_required: 'Your answering phone must be verified in the connected Twilio trial account before this call can start.',
    authentication_required: 'Please sign in to continue.',
    session_expired: 'Your session expired. Please sign in again.',
    call_in_progress: 'Finish your current call before starting another.',
    daily_call_limit: 'You have reached today’s call limit. Try again tomorrow.',
    call_minutes_limit: 'The call minute limit has been reached. Check your available usage.',
    number_pool_empty: 'No business number is available yet. Your account is still saved.',
    recording_check_cooldown: 'Please wait a minute before checking the recording again.',
    recording_not_recoverable: 'This call is not eligible for recording recovery.',
    processing_active: 'Your notes are still being prepared. Refresh to check their progress.',
  };
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(messages, code)) return messages[code];
  if (status === 401) return 'Please sign in again to continue.';
  if (status === 403) return 'This action is not available for your account.';
  if (status === 404) return 'This item is no longer available. Refresh and try again.';
  if (status === 409) return 'This item changed. Refresh to check its result before trying again.';
  if (status === 429) return 'Too many attempts. Please wait before trying again.';
  return 'Unable to complete this request. Check your details and try again.';
}

async function request<T>(
  path: string,
  userPhone: string,
  init: RequestInit = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const cancel = () => controller.abort();
  init.signal?.addEventListener('abort', cancel, { once: true });
  if (init.signal?.aborted) controller.abort();

  try {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(userPhone),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ApiError('errorGeneric', publicErrorMessage(response.status, detail), response.status);
    }
    return await response.json() as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('errorNetwork', controller.signal.aborted
      ? 'The request timed out. Refresh to check its result before trying again.'
      : 'Unable to reach Dimts. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
  }
}

export function listCalls(userPhone: string) {
  return request<{ calls: CallSummary[] }>('/api/calls', userPhone).then(
    (r) => r.calls
  );
}

export function endCall(id: string) {
  return request<{ status: 'ended' }>(`/api/calls/${id}/end`, '', { method: 'POST' });
}
export function getCall(id: string, userPhone: string) {
  return request<CallDetail>(`/api/calls/${id}`, userPhone);
}

export type DeletionRecord = { id: string; deleted_at: string | null;
  provider_deletion_status: 'pending' | 'unknown' | 'confirmed' | 'not_required' | null;
  provider_deletion_error: string | null; provider_deleted_at: string | null };
export function deleteCall(id: string) {
  return request<Pick<DeletionRecord, 'id' | 'deleted_at' | 'provider_deletion_status'>>(`/api/calls/${id}`, '', { method: 'DELETE', body: JSON.stringify({ confirm: 'delete-call' }) });
}
export function retryCallDeletion(id: string) {
  return request<{ status: string }>(`/api/calls/${id}/deletion/retry`, '', { method: 'POST' });
}
export function listCallDeletions() {
  return request<{ deletions: DeletionRecord[] }>('/api/call-deletions', '').then(result => result.deletions);
}
export function registerNotificationDevice(token: string) {
  return request<{ status: string }>('/api/notifications/device', '', { method: 'POST', body: JSON.stringify({ token }) });
}
export function removeNotificationDevice() {
  return request<{ status: string }>('/api/notifications/device', '', { method: 'DELETE' });
}
export function getNotificationStatus() {
  return request<{ devices: { id: string; disabled: boolean; updated_at: string }[];
    notifications: { call_id: string; status: string; error_code: string | null; created_at: string }[] }>('/api/notifications', '');
}

export function newCallRequestKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
export async function startCall(destination: string, userPhone: string, record = true, requestKey = newCallRequestKey()) {
  try {
    return await request<{ callId: string; status: string }>(
      '/api/calls',
      userPhone,
      { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify({ destination, record }) }
    );
  } catch (err) {
    if (err instanceof ApiError && err.messageKey === 'errorGeneric') {
      throw new ApiError('errorCallFailed', err.message, err.status);
    }
    throw err;
  }
}

export function reprocessCall(id: string, userPhone: string) {
  return request<{ status: string }>(`/api/calls/${id}/process`, userPhone, {
    method: 'POST',
  });
}

export function recoverCallRecording(id: string) {
  return request<{ status: 'available' | 'processing' | 'unavailable' | 'ambiguous' | 'unsupported' }>(
    `/api/calls/${id}/recording/reconcile`, '', { method: 'POST' });
}

export async function fetchCallExport(id: string, kind: 'notes' | 'audio', signal: AbortSignal) {
  const response = await fetch(`${BASE}/api/calls/${encodeURIComponent(id)}/${kind}`, {
    headers: authHeaders(''), cache: 'no-store', signal,
  });
  if (!response.ok) throw new Error(`Unable to export ${kind === 'audio' ? 'the recording' : 'call notes'}. Try again.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('The export was empty. Try again.');
  return bytes;
}

export function getUsage(userPhone: string) {
  return request<Usage>('/api/usage', userPhone);
}

export type Contact = { id: string; phone: string; display_name: string | null;
  company: string | null; notes: string | null; name_source: string; last_call_at: string | null };
export function listContacts(userPhone: string) {
  return request<{ contacts: Contact[] }>('/api/contacts', userPhone).then(r => r.contacts);
}
export function saveContact(contact: Contact, userPhone: string) {
  return request<Contact>(`/api/contacts/${contact.id}`, userPhone,
    { method: 'PATCH', body: JSON.stringify(contact) });
}
export async function exportContact(id: string, userPhone: string) {
  const response = await fetch(`${BASE}/api/contacts/${id}/vcard`, { headers: authHeaders(userPhone) });
  if (!response.ok) throw new ApiError('errorGeneric', 'Unable to export contact');
  return response.text();
}
