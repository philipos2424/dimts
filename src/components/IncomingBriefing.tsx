import { useEffect, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useApp } from '../AppContext';
import { getActiveIncoming } from '../api';
import { space, useTheme } from '../theme';
import { CallBriefing } from './CallBriefing';
import { Txt } from './Txt';

export function IncomingBriefing() {
  const { c } = useTheme();
  const { userPhone } = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const [call, setCall] = useState<{ id: string; destination: string } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    setCall(null);
    if (!userPhone || pathname === '/in-call') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const visible = Platform.OS === 'web' ? !document.hidden : AppState.currentState === 'active';
      let ringing = false;
      if (visible) {
        try {
          const result = await getActiveIncoming();
          ringing = !!result.call;
          if (active) setCall(result.call);
        } catch { if (active) setCall(null); }
      } else if (active) setCall(null);
      // Every request wakes a server function; check less often while nothing rings.
      if (active) timer = setTimeout(poll, ringing ? 3000 : 6000);
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [userPhone, pathname]);
  if (!userPhone || !call || dismissed === call.id) return null;
  return <ScrollView style={{ maxHeight: 350, backgroundColor: c.raised }} contentContainerStyle={{ padding: space.md, gap: space.sm }}>
    <Txt weight="bold">Incoming call · {call.destination}</Txt>
    <Txt tone="muted">Answer on your phone. This panel shows your private call memory.</Txt>
    <CallBriefing callId={call.id} />
    <View style={{ flexDirection: 'row', gap: space.lg }}>
      <Pressable accessibilityRole="button" onPress={() => router.push(`/in-call?id=${call.id}&dest=${encodeURIComponent(call.destination)}`)}>
        <Txt tone="accent">Open call screen</Txt>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => setDismissed(call.id)}><Txt tone="muted">Hide briefing</Txt></Pressable>
    </View>
  </ScrollView>;
}
