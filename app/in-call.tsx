import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, View } from 'react-native';
import { CallBriefing } from '../src/components/CallBriefing';
import { useApp } from '../src/AppContext';
import { getCall } from '../src/api';
import { Txt } from '../src/components/Txt';
import { EndCall } from '../src/components/EndCall';
import { statusKey } from '../src/i18n';
import { needsPressOne } from '../src/consent';
import { radius, space, useTheme } from '../src/theme';

const SETTLED = new Set(['processing', 'ready', 'failed', 'missed', 'completed']);

export default function InCall() {
  const { c } = useTheme();
  const { t } = useApp();
  const { userPhone } = useApp();
  const router = useRouter();
  const { id, dest } = useLocalSearchParams<{ id: string; dest?: string }>();

  const [status, setStatus] = useState('initiating');
  const [seconds, setSeconds] = useState(0);
  const [recordingAgreed, setRecordingAgreed] = useState(false);
  const [recordingMessage, setRecordingMessage] = useState('Connecting…');
  const pulse = useRef(new Animated.Value(0.35)).current;

  // The one piece of ambient motion in the app: it stands in for the fact
  // that a recording is running, which nothing else on screen can show.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  useEffect(() => {
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!id || !userPhone) return;
    let active = true;

    const poll = setInterval(async () => {
      try {
        const call = await getCall(id, userPhone);
        if (!active) return;
        setStatus(call.status);
        setRecordingAgreed(call.recording_authorized && call.recording_start_status === 'started');
        setRecordingMessage(!call.record_enabled ? 'Continuing without recording.' :
          call.recording_start_status === 'unknown' ? 'Recording requested; startup is unconfirmed.' :
          call.recording_start_status === 'pending' ? 'Starting the agreed recording…' : 'Connecting…');
        if (SETTLED.has(call.status)) {
          clearInterval(poll);
          router.replace('/calls');
        }
      } catch {
        // Keep the screen up; Recents will show the real outcome.
      }
    }, 3000);

    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [id, userPhone, router]);

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const onCall = status === 'in-progress';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{
        flexGrow: 1,
        backgroundColor: c.bg,
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.xl,
        gap: space.md,
      }}
    >
      <Txt size="screen" weight="bold">
        {dest ?? ''}
      </Txt>

      <View style={{ width: '100%' }}><CallBriefing callId={id} /></View>

      <Txt size="subhead" tone="muted">
        {onCall ? clock : t(statusKey(status))}
      </Txt>

      {['initiating', 'ringing'].includes(status) && (
        <View style={{ gap: space.xs, maxWidth: 360 }}>
          <Txt style={{ textAlign: 'center' }}>{t('answerYourPhone')}</Txt>
          {needsPressOne(dest, userPhone) && <Txt style={{ textAlign: 'center' }} tone="muted">{t('pressOneToRecord')}</Txt>}
        </View>
      )}

      {onCall && recordingAgreed && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            marginTop: space.lg,
          }}
        >
          <Animated.View
            style={{
              width: 10,
              height: 10,
              borderRadius: radius.pill,
              backgroundColor: c.danger,
              opacity: pulse,
            }}
          />
          <Txt size="caption" tone="muted">
            Recording active
          </Txt>
        </View>
      )}
      {onCall && !recordingAgreed && <Txt tone="muted">{recordingMessage}</Txt>}

      <Pressable
        accessibilityRole="button"
        onPress={() => router.replace('/calls')}
        style={{ marginTop: space.xxl }}
        hitSlop={12}
      >
        <Txt tone="accent">{t('backToRecents')}</Txt>
      </Pressable>
      {id && !SETTLED.has(status) && <EndCall id={id} onEnded={() => router.replace('/calls')} />}
    </ScrollView>
  );
}
