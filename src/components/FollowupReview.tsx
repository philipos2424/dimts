import { useState } from 'react';
import { Linking, Pressable, TextInput, View } from 'react-native';
import { type Followups, generateFollowups, saveFollowups } from '../api';
import { color, space } from '../theme';
import { Section } from './Section';
import { Txt } from './Txt';

export function FollowupReview({ callId, initial }: { callId: string; initial: Followups | null }) {
  const [draft, setDraft] = useState<Followups | null>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await action(); } catch (err) { setMessage(err instanceof Error ? err.message : 'Unable to save draft'); }
    finally { setBusy(false); }
  };
  const field = (label: string, value: string, change: (text: string) => void, multiline = false) => (
    <View style={{ gap: space.xs }}>
      <Txt tone="muted">{label}</Txt>
      <TextInput accessibilityLabel={label} value={value} onChangeText={change} multiline={multiline}
        style={{ color: color.parchment, borderWidth: 1, borderColor: color.parchment, padding: space.sm, minHeight: multiline ? 100 : 44 }} />
    </View>
  );
  const button = (label: string, action: () => Promise<void>) => (
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(action)} style={{ paddingVertical: space.sm, opacity: busy ? 0.5 : 1 }}>
      <Txt tone="accent" weight="bold">{label}</Txt>
    </Pressable>
  );
  return <Section title="Follow-up drafts">
    <View style={{ gap: space.sm }}>
      <Txt tone="muted">Review the facts before using these drafts. Opening another app does not send mail or confirm a booking.</Txt>
      {!draft && button(busy ? 'Preparing drafts…' : 'Prepare follow-ups', async () => setDraft(await generateFollowups(callId)))}
      {draft && !draft.email && !draft.meeting && <Txt>No email or agreed meeting found in this conversation.</Txt>}
      {draft?.email && <>
        {field('Recipient email', draft.email.recipient, recipient => setDraft({ ...draft, email: { ...draft.email!, recipient } }))}
        {field('Subject', draft.email.subject, subject => setDraft({ ...draft, email: { ...draft.email!, subject } }))}
        {field('Email draft', draft.email.body, body => setDraft({ ...draft, email: { ...draft.email!, body } }), true)}
        {button('Review in mail app', async () => {
          if (!draft.email?.recipient || !draft.email.subject || !draft.email.body) throw new Error('Enter a recipient, subject and message first.');
          const saved = await saveFollowups(callId, draft); setDraft(saved);
          const email = saved.email!;
          await Linking.openURL(`mailto:${encodeURIComponent(email.recipient)}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`);
        })}
      </>}
      {draft?.meeting && <>
        <Txt>Time mentioned: {draft.meeting.time_text || 'Not specified'}</Txt>
        {field('Meeting title', draft.meeting.title, title => setDraft({ ...draft, meeting: { ...draft.meeting!, title } }))}
        {field('Meeting notes', draft.meeting.notes, notes => setDraft({ ...draft, meeting: { ...draft.meeting!, notes } }), true)}
        <Txt tone="muted">Confirm both times in UTC, for example 2026-10-02T14:00:00Z. UTC may differ from your local time.</Txt>
        {field('Start (UTC)', draft.meeting.start, start => setDraft({ ...draft, meeting: { ...draft.meeting!, start } }))}
        {field('End (UTC)', draft.meeting.end, end => setDraft({ ...draft, meeting: { ...draft.meeting!, end } }))}
        {button('Review in Google Calendar', async () => {
          if (!draft.meeting?.start || !draft.meeting.end || !draft.meeting.title) throw new Error('Enter a title and confirmed start and end times first.');
          const saved = await saveFollowups(callId, draft); setDraft(saved);
          const meeting = saved.meeting!;
          const compact = (time: string) => time.replace(/[-:]/g, '');
          await Linking.openURL(`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(meeting.title)}&details=${encodeURIComponent(meeting.notes)}&dates=${compact(meeting.start)}/${compact(meeting.end)}`);
        })}
      </>}
      {draft && button('Save edits', async () => { setDraft(await saveFollowups(callId, draft)); setMessage('Drafts saved.'); })}
      {!!message && <Txt>{message}</Txt>}
    </View>
  </Section>;
}
