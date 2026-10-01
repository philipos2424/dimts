import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, TextInput, View } from 'react-native';
import { type Followups, type FollowupEvent, generateFollowups, saveFollowups, rejectFollowup, getFollowupEvents } from '../api';
import { bookReviewedMeeting, getCalendarAction, reconcileMeeting, refreshFollowups, type CalendarAction } from '../api';
import { color, space } from '../theme';
import { Section } from './Section';
import { Txt } from './Txt';

export function FollowupReview({ callId, initial }: { callId: string; initial: Followups | null }) {
  const [draft, setDraft] = useState<Followups | null>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [events, setEvents] = useState<FollowupEvent[] | null>(null);
  const [booking, setBooking] = useState<CalendarAction | null>(null);
  const [bookingLoaded, setBookingLoaded] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    let mounted = true;
    getCalendarAction(callId).then(r => { if (mounted) { setBooking(r.action); setBookingLoaded(true); } })
      .catch(() => { if (mounted) setMessage('Could not load booking status. Refresh before booking.'); });
    return () => { mounted = false; };
  }, [callId]);
  const meetingLocked = !bookingLoaded || (booking && booking.status !== 'failed');
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
        style={{ color: color.parchment, borderWidth: 1, borderColor: color.parchment, padding: space.sm, minHeight: multiline ? 100 : 44 }} />
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
      <Txt tone="muted">Review the facts before using these drafts. Opening another app does not send mail or confirm a booking.</Txt>
      {booking && <View style={{ gap: space.xs }}>
        <Txt weight="bold">{booking.status === 'confirmed' ? 'Booked in Google Calendar' : booking.status === 'failed' ? 'Booking failed' : 'Booking result awaiting confirmation'}</Txt>
        <Txt>{booking.meeting.title} · {booking.meeting.start} – {booking.meeting.end}</Txt>
        {booking.status === 'confirmed' ? <>
          <Txt tone="muted">Event ID: {booking.event_id}</Txt>
          <Txt tone="muted">Saved to your primary calendar. No invitation was sent to the caller.</Txt>
          {booking.event_url && button('Open booked event', async () => { await Linking.openURL(booking.event_url!); })}
        </> : <Txt tone="muted">{booking.error_code || 'Checking the provider result.'} {booking.status !== 'failed' && 'Check this result before making another booking.'}</Txt>}
        {(booking.status === 'pending' || booking.status === 'unknown') && button('Check booking result', async () => setBooking((await reconcileMeeting(callId)).action))}
      </View>}
      {button('Refresh booking status', async () => { setBooking((await getCalendarAction(callId)).action); setBookingLoaded(true); })}
      {!draft && button(busy ? 'Preparing drafts…' : 'Prepare follow-ups', async () => setDraft(await generateFollowups(callId)))}
      {draft && !draft.email && !draft.meeting && <Txt>No email or agreed meeting found in this conversation.</Txt>}
      {draft?.email?.status === 'rejected' && <Txt tone="muted">Email proposal rejected.</Txt>}
      {draft?.email && draft.email.status !== 'rejected' && <>
        {evidence(draft.email)}
        {field('Recipient email', draft.email.recipient, recipient => setDraft({ ...draft, email: { ...draft.email!, recipient } }))}
        {field('Subject', draft.email.subject, subject => setDraft({ ...draft, email: { ...draft.email!, subject } }))}
        {field('Email draft', draft.email.body, body => setDraft({ ...draft, email: { ...draft.email!, body } }), true)}
        {button('Review in mail app', async () => {
          if (!draft.email?.recipient || !draft.email.subject || !draft.email.body) throw new Error('Enter a recipient, subject and message first.');
          const saved = await saveFollowups(callId, draft); setDraft(saved);
          const email = saved.email!;
          await Linking.openURL(`mailto:${encodeURIComponent(email.recipient)}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`);
        })}
        {button('Reject email proposal', async () => setDraft(await rejectFollowup(callId, 'email', draft.version)))}
      </>}
      {draft?.meeting?.status === 'rejected' && <Txt tone="muted">Meeting proposal rejected.</Txt>}
      {draft?.meeting && draft.meeting.status !== 'rejected' && !meetingLocked && <>
        {evidence(draft.meeting)}
        <Txt>Time mentioned: {draft.meeting.time_text || 'Not specified'}</Txt>
        {field('Meeting title', draft.meeting.title, title => setDraft({ ...draft, meeting: { ...draft.meeting!, title } }))}
        {field('Meeting notes', draft.meeting.notes, notes => setDraft({ ...draft, meeting: { ...draft.meeting!, notes } }), true)}
        <Txt tone="muted">Confirm both times in UTC, for example 2026-10-02T14:00:00Z. UTC may differ from your local time.</Txt>
        {field('Start (UTC)', draft.meeting.start, start => setDraft({ ...draft, meeting: { ...draft.meeting!, start } }))}
        {field('End (UTC)', draft.meeting.end, end => setDraft({ ...draft, meeting: { ...draft.meeting!, end } }))}
        {bookingLoaded && button('Confirm and book in my Google Calendar', async () => {
          const saved = await saveFollowups(callId, draft); setDraft(saved);
          try { setBooking((await bookReviewedMeeting(callId, saved.version!)).action); }
          catch (err) { setBookingLoaded(false); throw err; }
        })}
        {button('Review in Google Calendar', async () => {
          if (!draft.meeting?.start || !draft.meeting.end || !draft.meeting.title) throw new Error('Enter a title and confirmed start and end times first.');
          const saved = await saveFollowups(callId, draft); setDraft(saved);
          const meeting = saved.meeting!;
          const compact = (time: string) => time.replace(/[-:]/g, '');
          await Linking.openURL(`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(meeting.title)}&details=${encodeURIComponent(meeting.notes)}&dates=${compact(meeting.start)}/${compact(meeting.end)}`);
        })}
        {button('Reject meeting proposal', async () => setDraft(await rejectFollowup(callId, 'meeting', draft.version)))}
      </>}
      {draft && button('Save edits', async () => { setDraft(await saveFollowups(callId, draft)); setMessage('Drafts saved.'); })}
      {draft && !meetingLocked && button('Regenerate from transcript (replaces saved drafts)', async () => setDraft(await refreshFollowups(callId, draft.version ?? 0)))}
      {draft && button('Refresh review history', async () => setEvents(await getFollowupEvents(callId)))}
      {events?.map(event => <Txt key={event.version} tone="muted">
        {({ generated: 'Drafts prepared', regenerated: 'Drafts replaced from transcript', edited: 'Draft review saved', email_rejected: 'Email rejected', meeting_rejected: 'Meeting rejected' } as Record<string, string>)[event.kind] || event.kind}
        {' · '}{new Date(event.created_at).toLocaleString()}
      </Txt>)}
      {!!message && <Txt>{message}</Txt>}
    </View>
  </Section>;
}
