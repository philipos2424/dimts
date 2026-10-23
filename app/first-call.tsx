import { useRouter } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { BusinessNumber } from '../src/components/BusinessNumber';
import { Section } from '../src/components/Section';
import { Txt } from '../src/components/Txt';
import { space } from '../src/theme';
import { useCalls } from '../src/useCalls';

function Link({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={{ minHeight: 44, justifyContent: 'center' }}><Txt tone="accent">{label}</Txt></Pressable>;
}

const STATUS: Record<string, string> = {
  ready: 'Notes ready. Listen and check them.',
  failed: 'Needs attention. Open the call to see why.',
  completed: 'Finished without recorded notes.',
  missed: 'Not answered.',
  processing: 'Preparing notes.',
};

export default function FirstCall() {
  const router = useRouter();
  const { autoRecord, t } = useApp();
  const { calls, loading, errorKey, refresh } = useCalls();
  return <ScrollView contentContainerStyle={{ padding: space.md, gap: space.lg, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
    <Txt size="screen" weight="bold">Test your first call</Txt>
    <Txt tone="muted">Check a real call with another person before you rely on Dimts with clients.</Txt>
    <Link label="Just want to see the notes? Try the 1-minute demo call" onPress={() => router.push('/demo-call')} />

    <Section title="1. Call someone">
      <Txt>Ask a friend with a different phone to help. Open the dialer and enter their number. Your phone rings first from your Dimts number: answer it, then their phone rings.</Txt>
      <Txt tone="muted">They hear “This call is recorded and summarized by Dimts AI.” first. With a number in Germany, Austria or the Gulf, both of you press 1 to agree instead.</Txt>
      {!autoRecord && <Txt tone="muted">Recording is off. Turn it on in Settings first.</Txt>}
      <Link label={autoRecord ? 'Open the dialer' : 'Open Settings to turn on recording'}
        onPress={() => router.push(autoRecord ? '/dialer' : '/settings')} />
    </Section>

    <Section title="2. Say things you can check">
      <Txt>Agree on a pretend price, a meeting day and time, and one promise. A minute is enough. Keep talking until just before you hang up.</Txt>
    </Section>

    <Section title="3. Check the notes against the audio">
      <Txt>Open the call, play the start, middle and end, and check that both voices are clear and the summary matches.</Txt>
      {errorKey && <Txt accessibilityRole="alert" tone="muted">{t(errorKey)}</Txt>}
      <Link label={loading ? 'Checking…' : 'Refresh'} disabled={loading} onPress={() => { void refresh(); }} />
      {!loading && !calls.length && <Txt tone="muted">No calls yet. Make the call above, then refresh.</Txt>}
      {calls.slice(0, 5).map(call => <View key={call.id} style={{ gap: space.xs }}>
        <Link label={`${call.contact_name ?? call.destination} · ${call.direction === 'inbound' ? 'Incoming' : 'Outgoing'}`}
          onPress={() => router.push(`/call/${call.id}`)} />
        <Txt size="caption" tone="muted">{STATUS[call.status] ?? 'Call in progress.'}</Txt>
      </View>)}
    </Section>

    <Section title="4. Try an incoming call">
      <Txt>Ask your friend to call your business number. It rings your phone showing their number. Let one call ring out to test voicemail.</Txt>
      <BusinessNumber />
    </Section>

    <Section title="Before you rely on it">
      <Txt tone="muted">Dimts records calls made from the app or through your business number, not ordinary phone or WhatsApp calls. Test calls use your minutes. Repeat once with your usual headset or Bluetooth. A suggested follow-up is not sent until you confirm it, and a Gmail draft is not a sent email. If audio is missing, open the call for recovery options and keep its call ID for support.</Txt>
      <Link label="Notification and Google settings" onPress={() => router.push('/settings')} />
    </Section>
  </ScrollView>;
}
