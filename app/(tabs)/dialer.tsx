import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { ApiError, startCall, newCallRequestKey } from '../../src/api';
import { Banner } from '../../src/components/Banner';
import { Txt } from '../../src/components/Txt';
import { CallBriefing } from '../../src/components/CallBriefing';
import { geezDigits, type Key } from '../../src/i18n';
import { radius, space, type, useTheme } from '../../src/theme';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export default function Dialer() {
  const { c } = useTheme();
  const { t, lang, userPhone, autoRecord } = useApp();
  const router = useRouter();
  const params = useLocalSearchParams<{ number?: string }>();
  const [number, setNumber] = useState('+1');
  // Opened from a person page: start with their number.
  useEffect(() => { if (params.number && /^\+[1-9]\d{6,14}$/.test(params.number)) setNumber(params.number); }, [params.number]);
  const [errorKey, setErrorKey] = useState<Key | null>(null);
  const [errorDetail, setErrorDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; number: string; record: boolean } | null>(null);
  const submitting = useRef(false);

  const dialable = /^\+[1-9]\d{6,14}$/.test(number);

  async function placeCall() {
    if (!userPhone || !dialable || submitting.current) return;
    submitting.current = true;
    if (!pending.current || pending.current.number !== number || pending.current.record !== autoRecord) {
      pending.current = { key: newCallRequestKey(), number, record: autoRecord };
    }
    setBusy(true);
    setErrorKey(null); setErrorDetail('');
    try {
      const { callId } = await startCall(number, userPhone, autoRecord, pending.current.key);
      pending.current = null;
      router.push(`/in-call?id=${callId}&dest=${encodeURIComponent(number)}`);
    } catch (err) {
      // Retain the key after a lost response: retry must resolve the same call.
      if (err instanceof ApiError && err.status && err.status < 500) pending.current = null;
      setErrorKey(err instanceof ApiError ? err.messageKey : 'errorCallFailed');
      setErrorDetail(err instanceof ApiError ? err.message : '');
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'space-between' }}>
      {errorKey && (
        <Banner message={lang === 'en' && errorDetail ? errorDetail : t(errorKey)} onDismiss={() => { setErrorKey(null); setErrorDetail(''); }} />
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

      {dialable && <View style={{ padding: space.md }}><CallBriefing phone={number} /></View>}

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
              backgroundColor: pressed ? c.card : 'transparent',
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="+"
          onPress={() => setNumber((n) => n.startsWith('+') ? n : `+${n}`)}
          hitSlop={12}
          style={{ width: 64, minHeight: 64, alignItems: 'center', justifyContent: 'center' }}
        >
          <Txt size="title" tone="accent">+</Txt>
        </Pressable>

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
            backgroundColor: dialable && !busy ? c.ok : c.line,
          }}
        >
          <Txt size="title" weight="bold" style={{ color: c.ink }}>
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
    </ScrollView>
  );
}
