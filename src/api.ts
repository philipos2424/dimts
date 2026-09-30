import type { Key } from './i18n';
import { Platform } from 'react-native';

const BASE = Platform.OS === 'web' ? '' : (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');
let sessionToken: string | null = null;
export function setApiSession(token: string | null) { sessionToken = token; }

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
export type Followups = {
  email: { subject: string; body: string; recipient: string } | null;
  meeting: { title: string; notes: string; time_text: string; start: string; end: string } | null;
};
export function generateFollowups(id: string) {
  return request<Followups>(`/api/calls/${id}/followups`, '', { method: 'POST' });
}
export function saveFollowups(id: string, draft: Followups) {
  return request<Followups>(`/api/calls/${id}/followups`, '', { method: 'PATCH', body: JSON.stringify(draft) });
}

export type CallDetail = CallSummary & {
  record_enabled: boolean;
  parent_consent_at: string | null;
  child_consent_at: string | null;
  recording_url: string | null;
  audio_url: string | null;
  transcript: string | null;
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

async function request<T>(
  path: string,
  userPhone: string,
  init: RequestInit = {}
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(userPhone),
        ...init.headers,
      },
    });
  } catch (err) {
    throw new ApiError('errorNetwork', String(err));
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ApiError('errorGeneric', `HTTP ${response.status}: ${detail}`, response.status);
  }

  return response.json() as Promise<T>;
}

export function listCalls(userPhone: string) {
  return request<{ calls: CallSummary[] }>('/api/calls', userPhone).then(
    (r) => r.calls
  );
}

export function getCall(id: string, userPhone: string) {
  return request<CallDetail>(`/api/calls/${id}`, userPhone);
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
