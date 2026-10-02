import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Link } from 'expo-router';
import { useApp } from '../src/AppContext';
import { PrimaryButton } from '../src/components/PrimaryButton';
import { Txt } from '../src/components/Txt';
import { RECORDING_NOTICE } from '../src/legal';
import { color, radius, space } from '../src/theme';

export default function TermsAccept() {
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
      <View style={{ backgroundColor: color.surface, borderRadius: radius.md, padding: space.md }}>
        <Txt weight="bold">“{RECORDING_NOTICE}”</Txt>
      </View>
      <Txt tone="muted">Your calls are stored in Europe and kept until you delete them. You can download or delete everything at any time in Settings.</Txt>
      <View style={{ flexDirection: 'row', gap: space.lg }}>
        <Link href="/privacy"><Txt tone="accent">Privacy policy</Txt></Link>
        <Link href="/terms"><Txt tone="accent">Terms of service</Txt></Link>
      </View>
      <PrimaryButton label="Agree and continue" onPress={agree} busy={busy} />
      {error ? <Txt accessibilityRole="alert" tone="muted">{error}</Txt> : null}
    </ScrollView>
  );
}
