import { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { type Followups, type FollowupEvent, generateFollowups, saveFollowups, rejectFollowup, getFollowupEvents, refreshFollowups } from '../api';
import { addToCalendar, openInMailApp } from '../calendar';
import { space, useTheme } from '../theme';
import { Section } from './Section';
import { Txt } from './Txt';

export function FollowupReview({ callId, initial }: { callId: string; initial: Followups | null }) {
  const { c } = useTheme();
  const [draft, setDraft] = useState<Followups | null>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [events, setEvents] = useState<FollowupEvent[] | null>(null);
  const running = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setMessage('');
    try { await action(); } catch (err) { setMessage(err instanceof Error ? err.message : 'Unable to save draft'); }
    finally { running.current = false; setBusy(false); }
  };
  const field = (label: string, value: string, change: (text: string) => void, multiline = false) => (
    <View style={{ gap: space.xs }}>
      <Txt tone="muted">{label}</Txt>
      <TextInput accessibilityLabel={label} value={value} onChangeText={change} multiline={multiline}
        style={{ color: c.ink, borderWidth: 1, borderColor: c.ink, padding: space.sm, minHeight: multiline ? 100 : 44 }} />
    </View>
  );
  const button = (label: string, action: () => Promise<void>) => (
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(action)} style={{ paddingVertical: space.sm, opacity: busy ? 0.5 : 1 }}>
      <Txt tone="accent" weight="bold">{label}</Txt>
    </Pressable>
  );
  const evidence = (proposal: NonNullable<Followups['email']> | NonNullable<Followups['meeting']>) => <View style={{ gap: space.xs }}>
    {proposal.evidence ? <>
      <Txt weight="bold">Why this was proposed</Txt>
      <Txt>{proposal.evidence.reason}</Txt>
      {proposal.evidence.quotes.map((quote, i) => <Txt key={i} tone="muted">“{quote}”</Txt>)}
      <Txt tone="muted">Model confidence: {Math.round(proposal.evidence.confidence * 100)}% · Review required</Txt>
    </> : <Txt tone="muted">This older draft has no saved evidence. Check the transcript before using it.</Txt>}
  </View>;
  return <Section title="Follow-up drafts">
    <View style={{ gap: space.sm }}>
      <Txt tone="muted">Check the facts first. Nothing is sent or booked until you do it in your mail or calendar app.</Txt>
      {!draft && button(busy ? 'Preparing drafts…' : 'Prepare follow-ups', async () => setDraft(await generateFollowups(callId)))}
      {draft && !draft.email && !draft.meeting && <Txt>No email or agreed meeting found in this conversation.</Txt>}
      {draft?.email?.status === 'rejected' && <Txt tone="muted">Email proposal rejected.</Txt>}
      {draft?.email && draft.email.status !== 'rejected' && <>
        {evidence(draft.email)}
        {field('Recipient email', draft.email.recipient, recipient => setDraft({ ...draft, email: { ...draft.email!, recipient } }))}
        {field('Subject', draft.email.subject, subject => setDraft({ ...draft, email: { ...draft.email!, subject } }))}
        {field('Email draft', draft.email.body, body => setDraft({ ...draft, email: { ...draft.email!, body } }), true)}
        {button('Open in mail app', async () => {
          if (!draft.email?.subject || !draft.email.body) throw new Error('Enter a subject and message first.');
          const saved = await saveFollowups(callId, draft); setDraft(saved);
          await openInMailApp(saved.email!);
        })}
        {button('Reject email proposal', async () => setDraft(await rejectFollowup(callId, 'email', draft.version)))}
      </>}
      {draft?.meeting?.status === 'rejected' && <Txt tone="muted">Meeting proposal rejected.</Txt>}
      {draft?.meeting && draft.meeting.status !== 'rejected' && <>
        {evidence(draft.meeting)}
        <Txt>Time mentioned: {draft.meeting.time_text || 'Not specified'}</Txt>
        {field('Meeting title', draft.meeting.title, title => setDraft({ ...draft, meeting: { ...draft.meeting!, title } }))}
        {field('Meeting notes', draft.meeting.notes, notes => setDraft({ ...draft, meeting: { ...draft.meeting!, notes } }), true)}
        {button('Add to calendar', async () => {
          if (!draft.meeting?.title) throw new Error('Enter a meeting title first.');
          const saved = await saveFollowups(callId, draft); setDraft(saved);
          // The phone's form shows the time to confirm; the draft time is only a starting point.
          await addToCalendar(saved.meeting!);
        })}
        {button('Reject meeting proposal', async () => setDraft(await rejectFollowup(callId, 'meeting', draft.version)))}
      </>}
      {draft && button('Save edits', async () => { setDraft(await saveFollowups(callId, draft)); setMessage('Drafts saved.'); })}
      {draft && button('Regenerate from transcript (replaces saved drafts)', async () => setDraft(await refreshFollowups(callId, draft.version ?? 0)))}
      {draft && button('Refresh review history', async () => setEvents(await getFollowupEvents(callId)))}
      {events?.map(event => <Txt key={event.version} tone="muted">
        {({ generated: 'Drafts prepared', regenerated: 'Drafts replaced from transcript', edited: 'Draft review saved', email_rejected: 'Email rejected', meeting_rejected: 'Meeting rejected' } as Record<string, string>)[event.kind] || event.kind}
        {' · '}{new Date(event.created_at).toLocaleString()}
      </Txt>)}
      {!!message && <Txt>{message}</Txt>}
    </View>
  </Section>;
}
