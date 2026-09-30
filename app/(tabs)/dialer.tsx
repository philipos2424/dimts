import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { ApiError, startCall } from '../../src/api';
import { Banner } from '../../src/components/Banner';
import { Txt } from '../../src/components/Txt';
import { geezDigits, type Key } from '../../src/i18n';
import { color, radius, space, type } from '../../src/theme';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export default function Dialer() {
  const { t, lang, userPhone, autoRecord } = useApp();
  const router = useRouter();
  const [number, setNumber] = useState('+1');
  const [errorKey, setErrorKey] = useState<Key | null>(null);
  const [busy, setBusy] = useState(false);

  const dialable = /^\+[1-9]\d{6,14}$/.test(number);

  async function placeCall() {
    if (!userPhone || !dialable || busy) return;
    setBusy(true);
    try {
      const { callId } = await startCall(number, userPhone, autoRecord);
      router.push(`/in-call?id=${callId}&dest=${encodeURIComponent(number)}`);
    } catch (err) {
      setErrorKey(err instanceof ApiError ? err.messageKey : 'errorCallFailed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: 'space-between' }}>
      {errorKey && (
        <Banner message={t(errorKey)} onDismiss={() => setErrorKey(null)} />
      )}

      <View style={{ alignItems: 'center', paddingVertical: space.xl }}>
        <Txt
          size="display"
          weight="bold"
          numberOfLines={1}
          adjustsFontSizeToFit
          accessibilityLabel={number}
          style={{ letterSpacing: 1 }}
        >
          {number || ' '}
        </Txt>
        {!dialable && (
          <Txt size="caption" tone="faint" style={{ marginTop: space.sm }}>
            {t('enterNumber')}
          </Txt>
        )}
      </View>

      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'center',
          paddingHorizontal: space.lg,
        }}
      >
        {KEYS.map((key) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={key}
            onPress={() => setNumber((n) => n + key)}
            style={({ pressed }) => ({
              width: '33.33%',
              height: 74,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? color.surface : 'transparent',
              borderRadius: radius.md,
            })}
          >
            <Txt size="keypad" style={{ lineHeight: type.keypad + 4 }}>
              {key}
            </Txt>
            {/* Ge'ez numerals sit under the Latin digits for Amharic readers. */}
            {lang === 'am' && geezDigits[key] && (
              <Txt size="caption" tone="faint" style={{ lineHeight: 15 }}>
                {geezDigits[key]}
              </Txt>
            )}
          </Pressable>
        ))}
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.xl,
          paddingBottom: space.xl,
          paddingTop: space.md,
        }}
      >
        <View style={{ width: 64 }} />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('call')}
          accessibilityState={{ disabled: !dialable || busy }}
          disabled={!dialable || busy}
          onPress={placeCall}
          style={{
            width: 72,
            height: 72,
            borderRadius: radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: dialable && !busy ? color.verdigris : color.line,
          }}
        >
          <Txt size="title" weight="bold" style={{ color: color.parchment }}>
            {t('call')}
          </Txt>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('delete')}
          onPress={() => setNumber((n) => n.slice(0, -1))}
          onLongPress={() => setNumber('')}
          hitSlop={12}
          style={{ width: 64, alignItems: 'center' }}
        >
          <Txt size="title" tone="muted">
            ⌫
          </Txt>
        </Pressable>
      </View>
    </View>
  );
}
