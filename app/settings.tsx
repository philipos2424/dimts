import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { useRouter } from 'expo-router';
import { getBilling, type Billing } from '../src/api';
import { formatCredits } from '../src/billing';
import { Section } from '../src/components/Section';
import { Txt } from '../src/components/Txt';
import { BusinessNumber } from '../src/components/BusinessNumber';
import { CallerIdSettings } from '../src/components/CallerIdSettings';
import { CallDeletionHistory } from '../src/components/CallDeletion';
import { NotificationSettings } from '../src/components/NotificationSettings';
import { FirstCallLink } from '../src/components/FirstCallLink';
import { DataControls } from '../src/components/DataControls';
import { AppLockSetting } from '../src/components/AppLockSetting';
import { SignedInDevices } from '../src/components/SignedInDevices';
import type { Lang } from '../src/i18n';
import { radius, space, useTheme } from '../src/theme';

const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'am', label: 'አማርኛ' },
];

export default function Settings() {
  const { c } = useTheme();
  const { t, lang, setLang, autoRecord, setAutoRecord, userPhone, setUserPhone } =
    useApp();
  const router = useRouter();
  const [billing, setBilling] = useState<Billing | null>(null);

  useEffect(() => {
    if (!userPhone) return;
    getBilling().then(setBilling).catch(() => {});
  }, [userPhone]);

  return (
    <ScrollView contentContainerStyle={{ padding: space.md, gap: space.xl }}>
      <BusinessNumber />
      <CallerIdSettings />
      <FirstCallLink />
      {/* Google sign-in is off until Google verifies the app; follow-ups use the phone's mail app and calendar. */}
      <CallDeletionHistory />
      <NotificationSettings />
      <AppLockSetting />
      <SignedInDevices />
      <DataControls />
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
                  backgroundColor: active ? c.brand : c.card,
                }}
              >
                <Txt
                  weight={active ? 'bold' : 'regular'}
                  style={{ color: active ? c.bg : c.ink }}
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
            trackColor={{ false: c.line, true: c.ok }}
            thumbColor={c.ink}
          />
        </View>
      </Section>

      <Section title={t('minutesThisMonth')}>
        <Pressable accessibilityRole="link" onPress={() => router.push('/plans')} style={{ gap: space.xs }}>
          <Txt size="screen" weight="bold">
            {billing ? `${Math.round(billing.minutes_used)} / ${billing.minutes_included}` : '—'}
          </Txt>
          {billing && (
            <Txt tone="muted">
              {billing.tier.toUpperCase()} · {formatCredits(billing.credits_cents, lang)} · <Txt tone="accent" weight="bold">{lang === 'am' ? 'ዕቅድ ›' : 'Plan ›'}</Txt>
            </Txt>
          )}
        </Pressable>
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
