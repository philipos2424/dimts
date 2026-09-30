import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { getCall } from '../src/api';
import { Txt } from '../src/components/Txt';
import { statusKey } from '../src/i18n';
import { color, radius, space } from '../src/theme';

const SETTLED = new Set(['processing', 'ready', 'failed', 'missed', 'completed']);

export default function InCall() {
  const { t } = useApp();
  const { userPhone } = useApp();
  const router = useRouter();
  const { id, dest } = useLocalSearchParams<{ id: string; dest?: string }>();

  const [status, setStatus] = useState('initiating');
  const [seconds, setSeconds] = useState(0);
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
        if (SETTLED.has(call.status)) {
          clearInterval(poll);
          router.replace('/');
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
    <View
      style={{
        flex: 1,
        backgroundColor: color.ink,
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.xl,
        gap: space.md,
      }}
    >
      <Txt size="screen" weight="bold">
        {dest ?? ''}
      </Txt>

      <Txt size="subhead" tone="muted">
        {onCall ? clock : t(statusKey(status))}
      </Txt>

      {onCall && (
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
              backgroundColor: color.madder,
              opacity: pulse,
            }}
          />
          <Txt size="caption" tone="muted">
            {t('recording')}
          </Txt>
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        onPress={() => router.replace('/')}
        style={{ marginTop: space.xxl }}
        hitSlop={12}
      >
        <Txt tone="accent">{t('backToRecents')}</Txt>
      </Pressable>
    </View>
  );
}
