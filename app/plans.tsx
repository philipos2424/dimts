import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useApp } from '../src/AppContext';
import { ApiError, getBilling, openBillingPortal, startCheckout, type Billing, type Interval, type PlanId } from '../src/api';
import { COUNTRY_NAMES, canBuyHere, formatCredits, formatPrice } from '../src/billing';
import { Banner } from '../src/components/Banner';
import { Button } from '../src/components/Button';
import { Card } from '../src/components/Card';
import { Pill } from '../src/components/Pill';
import { Section } from '../src/components/Section';
import { Txt } from '../src/components/Txt';
import { radius, space, useTheme } from '../src/theme';

const COPY = {
  en: {
    current: 'Your plan', minutes: (used: number, total: number) => `${used} of ${total} minutes used this month`,
    credits: 'Credits', renews: (d: string) => `Renews on ${d}`, ends: (d: string) => `Ends on ${d}, then returns to Free`,
    pastDue: 'Your last payment failed. Update your card to keep your plan.',
    manage: 'Manage plan, card and invoices', monthly: 'Monthly', yearly: 'Yearly', twoFree: '2 months free',
    perMonth: '/month', perYear: '/year', recommended: 'Most popular', yourPlan: 'Current plan',
    choose: (name: string) => `Choose ${name}`, minutesIncluded: (n: number) => `${n.toLocaleString()} minutes a month`,
    renewsLine: (price: string, interval: Interval) => `Billed ${price} every ${interval === 'month' ? 'month' : 'year'} until you cancel. Cancel any time here; you keep the plan until the period ends. Tax may be added at checkout.`,
    addCredits: 'Add credits', creditsLine: (n: string) => `${n} of call credit. Never expires.`,
    creditsHelp: 'Credits pay for calls to or from the countries below, and for calls after your plan minutes run out.',
    rates: 'Calling rates', ratesIncluded: 'United States, Canada, United Kingdom and Europe: plan minutes.',
    rateHeader: 'Extra, paid from credits, for each phone ringing in:',
    perMin: '/min',
    overage: (n: string) => `After your plan minutes run out: ${n} a minute.`,
    afterCheckout: 'Payment received. Your plan updates in a few seconds.',
    webOnly: 'Plans and credits can be bought at dimts.app from any browser.',
    regional: 'Regional pricing for your country.',
    free: 'Free', pro: 'Pro', business: 'Business',
  },
  am: {
    current: 'የእርስዎ ዕቅድ', minutes: (used: number, total: number) => `በዚህ ወር ከ${total} ደቂቃ ${used} ተጠቅመዋል`,
    credits: 'ክሬዲት', renews: (d: string) => `${d} ላይ ይታደሳል`, ends: (d: string) => `${d} ላይ ያበቃል፣ ከዚያ ወደ ነፃ ይመለሳል`,
    pastDue: 'የመጨረሻው ክፍያ አልተሳካም። ዕቅድዎን ለማቆየት ካርድዎን ያዘምኑ።',
    manage: 'ዕቅድ፣ ካርድ እና ደረሰኞችን ያስተዳድሩ', monthly: 'ወርሃዊ', yearly: 'ዓመታዊ', twoFree: '2 ወር ነፃ',
    perMonth: '/በወር', perYear: '/በዓመት', recommended: 'በብዛት የሚመረጥ', yourPlan: 'የአሁኑ ዕቅድ',
    choose: (name: string) => `${name} ይምረጡ`, minutesIncluded: (n: number) => `በወር ${n.toLocaleString()} ደቂቃ`,
    renewsLine: (price: string, interval: Interval) => `እስኪሰርዙ ድረስ በየ${interval === 'month' ? 'ወሩ' : 'ዓመቱ'} ${price} ይከፈላል። በማንኛውም ጊዜ እዚህ መሰረዝ ይችላሉ፤ ዕቅዱ የተከፈለበት ጊዜ እስኪያልቅ ይቆያል። ግብር በክፍያ ጊዜ ሊጨመር ይችላል።`,
    addCredits: 'ክሬዲት ይጨምሩ', creditsLine: (n: string) => `${n} የጥሪ ክሬዲት። ጊዜው አያልፍም።`,
    creditsHelp: 'ክሬዲት ከታች ወዳሉት አገሮች ለሚደረጉ ወይም ከእነሱ ለሚመጡ ጥሪዎች፣ እና የዕቅድ ደቂቃዎ ካለቀ በኋላ ለሚደረጉ ጥሪዎች ይከፍላል።',
    rates: 'የጥሪ ዋጋ', ratesIncluded: 'አሜሪካ፣ ካናዳ፣ እንግሊዝ እና አውሮፓ፦ የዕቅድ ደቂቃ።',
    rateHeader: 'ከክሬዲት የሚከፈል ተጨማሪ፣ እዚህ ለሚደውል ለእያንዳንዱ ስልክ፦',
    perMin: '/በደቂቃ',
    overage: (n: string) => `የዕቅድ ደቂቃ ካለቀ በኋላ፦ በደቂቃ ${n}።`,
    afterCheckout: 'ክፍያው ደርሷል። ዕቅድዎ በጥቂት ሰከንዶች ውስጥ ይዘመናል።',
    webOnly: 'ዕቅድ እና ክሬዲት በማንኛውም ብራውዘር dimts.app ላይ መግዛት ይቻላል።',
    regional: 'ለአገርዎ የተዘጋጀ ዋጋ።',
    free: 'ነፃ', pro: 'ፕሮ', business: 'ቢዝነስ',
  },
};

const FEATURES: Record<string, { en: string; am: string }> = {
  notes: { en: 'AI notes on every call', am: 'ለእያንዳንዱ ጥሪ የAI ማስታወሻ' },
  agreements: { en: 'Agreements with names, numbers and dates', am: 'ስምምነቶች ከስም፣ ቁጥር እና ቀን ጋር' },
  ask: { en: 'Ask questions across your calls', am: 'በጥሪዎችዎ ላይ ጥያቄ ይጠይቁ' },
  recaps: { en: 'One-tap recap to the other person', am: 'ለሌላው ሰው በአንድ ንክኪ ማጠቃለያ' },
  promises: { en: 'Promises tracker with reminders', am: 'የቃል ኪዳን መከታተያ ከማስታወሻ ጋር' },
  memory_check: { en: 'Memory check: flags when someone changes their word', am: 'የማስታወስ ፍተሻ፦ ቃላቸውን ሲቀይሩ ያሳውቃል' },
  business_number: { en: 'Your own business number', am: 'የራስዎ የንግድ ቁጥር' },
  google: { en: 'Google Calendar and Gmail drafts', am: 'Google Calendar እና Gmail ረቂቆች' },
  live_memory_check: { en: 'Live memory check during calls (coming soon)', am: 'በጥሪ ጊዜ የቀጥታ ፍተሻ (በቅርቡ)' },
  priority_support: { en: 'Priority support', am: 'ቅድሚያ ድጋፍ' },
};

function go(url: string) {
  // Same tab on the web, so Polar's success link brings the user straight back here.
  if (Platform.OS === 'web') window.location.assign(url);
  else Linking.openURL(url).catch(() => {});
}

export default function Plans() {
  const { c } = useTheme();
  const { lang, userPhone } = useApp();
  const copy = COPY[lang];
  const params = useLocalSearchParams<{ checkout?: string }>();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [interval, setBillingInterval] = useState<Interval>('month');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(params.checkout === 'done' ? copy.afterCheckout : '');

  const load = useCallback(() => getBilling().then(setBilling).catch(err => setError(err instanceof ApiError ? err.message : String(err))), []);
  // The session token is restored with userPhone; asking earlier reads as signed out.
  useEffect(() => { if (userPhone) load(); }, [userPhone, load]);
  // Polar's webhook lands moments after the redirect; check back a few times.
  useEffect(() => {
    if (params.checkout !== 'done' || !userPhone) return;
    const timers = [2000, 5000, 10000].map(ms => setTimeout(load, ms));
    return () => timers.forEach(clearTimeout);
  }, [params.checkout, userPhone, load]);

  async function buy(item: string) {
    setBusy(item); setError('');
    try { go((await startCheckout(item, interval)).url); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusy(null); }
  }
  async function manage() {
    setBusy('portal'); setError('');
    try { go((await openBillingPortal()).url); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusy(null); }
  }

  if (!billing) return <ScrollView contentContainerStyle={{ padding: space.md }}>{error ? <Banner message={error} onDismiss={() => setError('')} /> : <Txt tone="muted">…</Txt>}</ScrollView>;
  const { catalog, subscription } = billing;
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === 'am' ? 'am-ET' : undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const usedPct = Math.min(1, billing.minutes_used / Math.max(1, billing.minutes_included));
  const shop = canBuyHere && billing.purchasable;

  return (
    <ScrollView contentContainerStyle={{ padding: space.md, gap: space.xl, maxWidth: 720, width: '100%', alignSelf: 'center' }}>
      {error ? <Banner message={error} onDismiss={() => setError('')} /> : null}
      {notice ? <Banner message={notice} onDismiss={() => setNotice('')} /> : null}

      <Section title={copy.current}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
          <Txt size="title" weight="bold" serif>{copy[billing.tier]}</Txt>
          {subscription && <Txt tone="muted">{subscription.interval === 'year' ? copy.yearly : copy.monthly}</Txt>}
        </View>
        <Txt tone="muted">{copy.minutes(Math.round(billing.minutes_used), billing.minutes_included)}</Txt>
        <View style={{ height: 8, borderRadius: radius.pill, backgroundColor: c.line, overflow: 'hidden' }}>
          <View style={{ width: `${usedPct * 100}%`, height: '100%', backgroundColor: usedPct >= 0.9 ? c.warn : c.ok }} />
        </View>
        <Txt>{copy.credits}: <Txt weight="bold">{formatCredits(billing.credits_cents, lang)}</Txt></Txt>
        {subscription?.status === 'past_due' && <Txt tone="danger">{copy.pastDue}</Txt>}
        {subscription?.renews_at && <Txt tone="muted">{copy.renews(date(subscription.renews_at))}</Txt>}
        {subscription?.ends_at && <Txt tone="muted">{copy.ends(date(subscription.ends_at))}</Txt>}
        {shop && subscription && <Button variant="quiet" label={copy.manage} busy={busy === 'portal'} onPress={manage} />}
      </Section>

      {!shop && <Txt tone="muted">{copy.webOnly}</Txt>}

      {shop && (
        <View style={{ gap: space.md }}>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: space.sm }}>
            {(['month', 'year'] as Interval[]).map(option => {
              const active = interval === option;
              return (
                <Pressable key={option} accessibilityRole="radio" accessibilityState={{ selected: active }} onPress={() => setBillingInterval(option)}
                  style={{ flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: active ? c.brand : c.card, borderWidth: 1, borderColor: c.line }}>
                  <Txt weight="bold" style={{ color: active ? c.onBrand : c.ink }}>{option === 'month' ? copy.monthly : `${copy.yearly} · ${copy.twoFree}`}</Txt>
                </Pressable>
              );
            })}
          </View>
          {catalog.region === 'lite' && <Txt size="caption" tone="muted">{copy.regional}</Txt>}
          {catalog.plans.map(plan => {
            const current = billing.tier === plan.id;
            const price = plan.prices?.[interval];
            return (
              <Card key={plan.id} style={plan.id === 'pro' ? { borderColor: c.brand, borderWidth: 2 } : undefined}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Txt size="subhead" weight="bold">{copy[plan.id as PlanId]}</Txt>
                  {current ? <Pill tone="ok" label={copy.yourPlan} /> : plan.id === 'pro' ? <Pill tone="gold" label={copy.recommended} /> : null}
                </View>
                <Txt size="title" weight="bold">
                  {price ? formatPrice(price, lang) : formatPrice({ amount: 0, currency: catalog.currency }, lang)}
                  <Txt tone="muted">{price ? (interval === 'month' ? copy.perMonth : copy.perYear) : ''}</Txt>
                </Txt>
                <Txt weight="bold">{copy.minutesIncluded(plan.minutes)}</Txt>
                {plan.features.map(feature => <Txt key={feature} tone="muted">✓ {FEATURES[feature]?.[lang] ?? feature}</Txt>)}
                {price && !current && (
                  <>
                    <Button label={copy.choose(copy[plan.id as PlanId])} busy={busy === plan.id} disabled={busy !== null} onPress={() => buy(plan.id)} />
                    <Txt size="caption" tone="faint">{copy.renewsLine(formatPrice(price, lang), interval)}</Txt>
                  </>
                )}
              </Card>
            );
          })}
        </View>
      )}

      <Section title={copy.addCredits}>
        <Txt tone="muted">{copy.creditsHelp}</Txt>
        {shop && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {catalog.credit_packs.map(pack => (
              <Card key={pack.id} style={{ flexGrow: 1, flexBasis: 180 }}>
                <Txt size="subhead" weight="bold">{formatPrice(pack.price, lang)}</Txt>
                <Txt tone="muted" size="caption">{copy.creditsLine(formatCredits(pack.credits, lang))}</Txt>
                <Button compact label={copy.addCredits} busy={busy === pack.id} disabled={busy !== null} onPress={() => buy(pack.id)} />
              </Card>
            ))}
          </View>
        )}
      </Section>

      <Section title={copy.rates}>
        <Txt>{copy.ratesIncluded}</Txt>
        <Txt tone="muted">{copy.rateHeader}</Txt>
        {Object.entries(catalog.leg_surcharges).sort((a, b) => a[1] - b[1]).map(([code, cents]) => (
          <View key={code} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
            <Txt>{COUNTRY_NAMES[code]?.[lang] ?? `+${code}`}</Txt>
            <Txt weight="bold">{formatCredits(cents, lang)}{copy.perMin}</Txt>
          </View>
        ))}
        <Txt tone="muted">{copy.overage(formatCredits(catalog.overage_cents_per_min, lang))}</Txt>
      </Section>
    </ScrollView>
  );
}
