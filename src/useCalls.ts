import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useApp } from './AppContext';
import { ApiError, type CallSummary, listCalls } from './api';
import type { Key } from './i18n';

const POLL_MS = 5000;
const SETTLED = new Set(['ready', 'failed']);

/**
 * Call history, refreshed on focus and polled only while something is still
 * in flight. Once every row has settled the timer stops, so an idle Recents
 * screen costs nothing.
 */
export function useCalls() {
  const { userPhone } = useApp();
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [errorKey, setErrorKey] = useState<Key | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!userPhone) return;
    try {
      setCalls(await listCalls(userPhone));
      setErrorKey(null);
    } catch (err) {
      setErrorKey(err instanceof ApiError ? err.messageKey : 'errorGeneric');
    } finally {
      setLoading(false);
    }
  }, [userPhone]);

  const pending = calls.some((call) => !SETTLED.has(call.status));

  useFocusEffect(
    useCallback(() => {
      refresh();
      return () => {
        if (timer.current) clearTimeout(timer.current);
      };
    }, [refresh])
  );

  useEffect(() => {
    if (!pending) return;
    timer.current = setTimeout(refresh, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pending, calls, refresh]);

  return { calls, loading, errorKey, refresh, clearError: () => setErrorKey(null) };
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

export function formatWhen(iso: string, lang: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const locale = lang === 'am' ? 'am-ET' : 'en-GB';

  return sameDay
    ? date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
