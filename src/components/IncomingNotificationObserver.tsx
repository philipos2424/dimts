import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { useApp } from '../AppContext';
import { getCall } from '../api';
import { observeIncomingNotifications, restoreIncomingNotifications } from '../notifications';

export function IncomingNotificationObserver() {
  const { ready, userPhone } = useApp(); const router = useRouter();
  useEffect(() => {
    if (!ready || !userPhone) return;
    let cancelled = false, cleanup: (() => void) | undefined;
    void restoreIncomingNotifications(userPhone).catch(() => {});
    void observeIncomingNotifications(async id => {
      // Never trust a notification URL, phone number or caller identity. The
      // authenticated API proves ownership before any briefing is shown.
      const call = await getCall(id, userPhone);
      if (cancelled || call.deleted_at) return;
      if (['ringing','in-progress'].includes(call.status)) router.push(`/in-call?id=${call.id}&dest=${encodeURIComponent(call.destination)}`);
      else router.push(`/call/${call.id}`);
    }, () => { if (!cancelled) router.push('/plans'); }).then(stop => { if (cancelled) stop(); else cleanup = stop; }).catch(() => {});
    return () => { cancelled = true; cleanup?.(); };
  }, [ready,userPhone,router]);
  return null;
}
