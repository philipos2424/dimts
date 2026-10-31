import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { getCallQuote, type CallQuote } from '../api';
import { canBuyHere, formatCredits } from '../billing';
import { useApp } from '../AppContext';
import { Txt } from './Txt';

const COPY = {
  en: {
    plan: (left: number) => `Uses plan minutes · ${left} left`,
    credits: (rate: string, max: number) => `${rate} a minute from credits · enough for ${max} min`,
    overage: (rate: string, max: number) => `Plan minutes used up · ${rate} a minute from credits · enough for ${max} min`,
    empty: (rate: string) => `${rate} a minute from credits · add credits to call`,
    emptyHere: (rate: string) => `${rate} a minute from credits · not enough credit for this call`,
    balance: (b: string) => `Balance ${b}`,
  },
  am: {
    plan: (left: number) => `የዕቅድ ደቂቃ ይጠቀማል · ${left} ቀርቷል`,
    credits: (rate: string, max: number) => `ከክሬዲት በደቂቃ ${rate} · ለ${max} ደቂቃ ይበቃል`,
    overage: (rate: string, max: number) => `የዕቅድ ደቂቃ አልቋል · ከክሬዲት በደቂቃ ${rate} · ለ${max} ደቂቃ ይበቃል`,
    empty: (rate: string) => `ከክሬዲት በደቂቃ ${rate} · ለመደወል ክሬዲት ይጨምሩ`,
    emptyHere: (rate: string) => `${rate} a minute from credits · not enough credit for this call`,
    balance: (b: string) => `ቀሪ ${b}`,
  },
};

/** What this call will cost, shown before it connects. Tapping opens Plan. */
export function CallPrice({ phone }: { phone: string }) {
  const { lang } = useApp();
  const router = useRouter();
  const [quote, setQuote] = useState<CallQuote | null>(null);
  useEffect(() => {
    setQuote(null);
    let live = true;
    // Wait for typing to settle before asking.
    const timer = setTimeout(() => getCallQuote(phone).then(q => { if (live) setQuote(q); }).catch(() => {}), 400);
    return () => { live = false; clearTimeout(timer); };
  }, [phone]);
  if (!quote) return null;
  const copy = COPY[lang];
  const money = (cents: number) => formatCredits(cents, lang);
  const rate = quote.surcharge_cents_per_min + (quote.plan_minutes_left > 0 ? 0 : quote.overage_cents_per_min);
  const text = quote.pays_with === 'plan' ? copy.plan(quote.plan_minutes_left)
    : quote.max_minutes < 1 ? (canBuyHere ? copy.empty : copy.emptyHere)(money(rate))
    : quote.surcharge_cents_per_min > 0 ? copy.credits(money(rate), quote.max_minutes)
    : copy.overage(money(rate), quote.max_minutes);
  return (
    <Pressable accessibilityRole="link" onPress={() => router.push('/plans')} hitSlop={8} style={{ alignItems: 'center' }}>
      <Txt size="caption" tone={quote.max_minutes < 1 ? 'danger' : quote.pays_with === 'plan' ? 'muted' : 'gold'} style={{ textAlign: 'center' }}>
        {text}
      </Txt>
      {quote.pays_with === 'credits' && <Txt size="caption" tone="faint">{copy.balance(formatCredits(quote.credits_cents, lang))}</Txt>}
    </Pressable>
  );
}
