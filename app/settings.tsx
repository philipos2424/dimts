import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { getUsage, type Usage } from '../src/api';
import { Section } from '../src/components/Section';
import { Txt } from '../src/components/Txt';
import { BusinessNumber } from '../src/components/BusinessNumber';
import { GoogleConnections } from '../src/components/GoogleConnections';
import type { Lang } from '../src/i18n';
import { color, radius, space } from '../src/theme';

const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'am', label: 'አማርኛ' },
];

export default function Settings() {
  const { t, lang, setLang, autoRecord, setAutoRecord, userPhone, setUserPhone } =
    useApp();
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    if (!userPhone) return;
    getUsage(userPhone).then(setUsage).catch(() => {});
  }, [userPhone]);

  return (
    <ScrollView contentContainerStyle={{ padding: space.md, gap: space.xl }}>
      <BusinessNumber />
      <GoogleConnections />
      <Section title={t('language')}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {LANGUAGES.map(({ code, label }) => {
            const active = lang === code;
            return (
              <Pressable
                key={code}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => setLang(code)}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: space.md,
                  borderRadius: radius.md,
                  backgroundColor: active ? color.saffron : color.surface,
                }}
              >
                <Txt
                  weight={active ? 'bold' : 'regular'}
                  style={{ color: active ? color.ink : color.parchment }}
                >
                  {label}
                </Txt>
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section title={t('autoRecord')}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            paddingVertical: space.sm,
          }}
        >
          <Txt tone="muted" style={{ flex: 1 }}>
            {t('autoRecordHelp')}
          </Txt>
          <Switch
            value={autoRecord}
            onValueChange={setAutoRecord}
            trackColor={{ false: color.line, true: color.verdigris }}
            thumbColor={color.parchment}
          />
        </View>
      </Section>

      <Section title={t('minutesThisMonth')}>
        <Txt size="screen" weight="bold">
          {usage ? usage.minutes_used.toFixed(1) : '—'}
        </Txt>
      </Section>

      <Section title={t('yourNumber')}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}
        >
          <Txt size="subhead" style={{ flex: 1 }}>
            {userPhone ?? '—'}
          </Txt>
          <Pressable
            accessibilityRole="button"
            onPress={() => setUserPhone(null)}
            hitSlop={12}
          >
            <Txt tone="accent" weight="bold">
              {t('changeNumber')}
            </Txt>
          </Pressable>
        </View>
      </Section>
    </ScrollView>
  );
}
