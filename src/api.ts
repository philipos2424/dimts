import type { Key } from './i18n';

const BASE = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');

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

export type CallDetail = CallSummary & {
  recording_url: string | null;
  audio_url: string | null;
  transcript: string | null;
  next_moves: string[] | null;
  action_items: ActionItem[] | null;
  key_points: string[] | null;
  error: string | null;
};

export type Usage = { month: string; tier: string; minutes_used: number };

/** Carries an i18n key so callers can surface the failure in either language. */
export class ApiError extends Error {
  messageKey: Key;
  constructor(messageKey: Key, detail?: string) {
    super(detail ?? messageKey);
    this.messageKey = messageKey;
  }
}

export function audioUrlFor(callId: string): string {
  return `${BASE}/api/calls/${callId}/audio`;
}

/** expo-audio's AudioSource accepts headers, so the proxy stays authenticated. */
export function authHeaders(userPhone: string): Record<string, string> {
  return { 'x-user-phone': userPhone };
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
    throw new ApiError('errorGeneric', `HTTP ${response.status}: ${detail}`);
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

export async function startCall(destination: string, userPhone: string) {
  try {
    return await request<{ callId: string; status: string }>(
      '/api/calls',
      userPhone,
      { method: 'POST', body: JSON.stringify({ destination }) }
    );
  } catch (err) {
    if (err instanceof ApiError && err.messageKey === 'errorGeneric') {
      throw new ApiError('errorCallFailed', err.message);
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
