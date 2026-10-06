import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Link } from 'expo-router';
import { useApp } from '../src/AppContext';
import { PrimaryButton } from '../src/components/PrimaryButton';
import { Txt } from '../src/components/Txt';
import { AI_PROVIDERS, EMERGENCY_NOTICE, RECORDING_NOTICE } from '../src/legal';
import { radius, space, useTheme } from '../src/theme';

export default function TermsAccept() {
  const { c } = useTheme();
  const { acceptTerms } = useApp();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');

  async function agree() {
    setBusy(true); setError('');
    try { await acceptTerms(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to save. Try again.'); }
    finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.lg }}>
      <Txt size="screen" weight="bold" accessibilityRole="header">Before your first call</Txt>
      <Txt tone="muted">Dimts records your calls so its AI can tell you what was agreed and draft the next step. Every recorded call starts with a short notice to the other person:</Txt>
      <View style={{ backgroundColor: c.card, borderRadius: radius.md, padding: space.md }}>
        <Txt weight="bold">“{RECORDING_NOTICE}”</Txt>
      </View>
      <Txt weight="bold">Who handles your calls</Txt>
      <View style={{ gap: space.sm }}>
        {AI_PROVIDERS.map(p => (
          <Txt key={p.name} tone="muted">• <Txt weight="bold">{p.name}</Txt> gets your {p.gets} and {p.does}.</Txt>
        ))}
        <Txt tone="muted">Neither may keep your calls or use them to train AI. Recordings and notes are stored in Europe for 12 months unless you change this in Settings, and you can download or delete everything at any time.</Txt>
      </View>
      <Txt tone="muted">{EMERGENCY_NOTICE}</Txt>
      <Txt tone="muted">By continuing you confirm you are 18 or older and allow Dimts to send your calls to these providers.</Txt>
      <View style={{ flexDirection: 'row', gap: space.lg }}>
        <Link href="/privacy"><Txt tone="accent">Privacy policy</Txt></Link>
        <Link href="/terms"><Txt tone="accent">Terms of service</Txt></Link>
      </View>
      <PrimaryButton label="I agree" onPress={agree} busy={busy} />
      {error ? <Txt accessibilityRole="alert" tone="muted">{error}</Txt> : null}
    </ScrollView>
  );
}
