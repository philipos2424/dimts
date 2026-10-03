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

export default function FirstCall() {
  const router = useRouter();
  const { userPhone, autoRecord, t } = useApp();
  const { calls, loading, errorKey, refresh } = useCalls();
  return <ScrollView contentContainerStyle={{ padding: space.md, gap: space.lg }}>
    <Txt size="screen" weight="bold">Test your first call</Txt>
    <Txt tone="muted">This guide helps you check a real call. A recording file or completed AI notes do not prove that both people were captured clearly.</Txt>
    <Section title="1. Choose two separate phones">
      <Txt>Your signed-in mobile is {userPhone ?? 'not available'}. Ask another person to help, using a different phone number. Use made-up names and commitments for this test.</Txt>
      <Txt tone="muted">Dimts captures calls started here or routed through your business line. Ordinary handset and WhatsApp calls are outside this recording path. Test calls use your available minutes and may incur your carrier’s charges.</Txt>
    </Section>
    <Section title="2. Start a short outgoing call">
      <Txt>Open the dialer and enter the other person’s number with its country code. Your own phone rings first, from your Dimts number: answer it. That is Dimts connecting you. Then the other person’s phone rings.</Txt>
      <Txt tone="muted">There is nothing to press. The other person hears: “This call is recorded and summarized by Dimts AI.” Then the conversation starts. Calls with a Gulf number (UAE, Saudi Arabia, Qatar, Bahrain, Kuwait, Oman) are different: both of you press 1 to agree before recording.</Txt>
      {!autoRecord && <Txt tone="muted">Recording is currently off. Enable it in Settings before this recording test.</Txt>}
      <Link label={autoRecord ? 'Open dialer (does not place a call)' : 'Open Settings to enable recording'}
        onPress={() => router.push(autoRecord ? '/dialer' : '/settings')} />
    </Section>
    <Section title="3. Say something you can check later">
      <Txt>Take turns introducing yourselves. Discuss a pretend quote, then agree on a specific meeting date, time and time zone. Ask for an email draft to an address you control. Continue speaking near the end, then hang up.</Txt>
      <Txt tone="muted">About a minute is enough for an initial check. Repeat with your usual headset or Bluetooth route. One successful test does not establish reliability for future calls.</Txt>
    </Section>
    <Section title="4. Listen before trusting the notes">
      <Txt>Open the finished call below. Play the beginning, middle and end: can you hear both people clearly, and is the intended conversation present? Check the names, speaker labels, summary and proposed commitments against the audio.</Txt>
      <Txt tone="muted">Use timestamps to find a turn when available. Export the recording and notes, then open both saved files. If anything is missing, use the call’s error/recovery controls and keep its call ID for help. Do not treat missing audio as a passed test.</Txt>
      {errorKey && <Txt accessibilityRole="alert" tone="muted">{t(errorKey)}</Txt>}
      <Link label={loading ? 'Checking call results…' : 'Refresh call results'} disabled={loading} onPress={() => { void refresh(); }} />
      {!loading && !calls.length && <Txt tone="muted">No calls appear yet. Make the short routed call above, then refresh.</Txt>}
      {calls.slice(0,10).map(call => <View key={call.id} style={{ gap: space.xs }}>
        <Link label={`${call.contact_name ?? call.destination} · ${call.direction === 'inbound' ? 'Incoming' : 'Outgoing'}`}
          onPress={() => router.push(`/call/${call.id}`)} />
        <Txt size="caption" tone="muted">{call.status === 'ready' ? 'Notes ready — listen and check them.' :
          call.status === 'failed' ? 'Needs attention — open the call for its error and recovery options.' :
          call.status === 'completed' ? 'Finished without recorded notes.' : call.status === 'missed' ? 'Not answered.' :
          call.status === 'processing' ? 'Preparing notes or waiting for audio.' : 'Call in progress.'}</Txt>
      </View>)}
    </Section>
    <Section title="5. Repeat for incoming calls">
      <Txt>Get your business line below, then ask the other person to call that number. It should ring your signed-in mobile and show the caller’s own number. Repeat the playback and notes checks. Then let one call ring out without answering: the caller can leave a message, which appears as a Voicemail card.</Txt>
      <BusinessNumber />
      <Txt tone="muted">If no business number is available, the incoming test is not ready. Test with the app open, then backgrounded and locked; enable incoming alerts in Settings for an installed iPhone or Android app.</Txt>
      <Link label="Open notification settings" onPress={() => router.push('/settings')} />
    </Section>
    <Section title="6. Review follow-through separately">
      <Txt>Connect Google in Settings if available. On the call, inspect the transcript evidence, correct or reject suggestions, and confirm only the action you intend. Verify the event or draft in Google afterward.</Txt>
      <Txt tone="muted">A suggested action is not a completed action. A Gmail draft is not a sent email. An uncertain result needs reconciliation before trying again.</Txt>
    </Section>
  </ScrollView>;
}
