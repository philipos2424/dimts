import { Linking, Platform } from 'react-native';

export type CalendarDraft = { title: string; notes: string; start?: string | null; end?: string | null };

const parse = (value?: string | null) => {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
};

/**
 * Open the phone's own "new event" form, filled in from the call. The owner
 * checks the time and picks the calendar there, so it lands in Google,
 * Outlook or iCloud, whichever the phone uses, without Dimts ever holding a
 * calendar login. Nothing is saved until they tap Add.
 */
export async function addToCalendar(draft: CalendarDraft) {
  const start = parse(draft.start) ?? nextHour();
  const end = parse(draft.end) ?? new Date(start.getTime() + 30 * 60_000);
  if (Platform.OS === 'web') {
    const compact = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');
    await Linking.openURL(`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(draft.title)}`
      + `&details=${encodeURIComponent(draft.notes)}&dates=${compact(start)}/${compact(end)}`);
    return;
  }
  const Calendar = await import('expo-calendar');
  if (Platform.OS === 'ios') {
    // Write-only: Dimts can add this event but never read the owner's calendar.
    const permission = await Calendar.requestCalendarPermissions(true);
    if (!permission.granted) throw new Error('Allow Dimts to add events in your phone’s Settings, then try again.');
  }
  await Calendar.getDefaultCalendarSync().addEventWithForm({ title: draft.title, notes: draft.notes, startDate: start, endDate: end });
}

function nextHour() {
  const at = new Date();
  at.setHours(at.getHours() + 1, 0, 0, 0);
  return at;
}

/** The phone's mail app with the message filled in; the owner sends it themselves. */
export async function openInMailApp(email: { recipient: string; subject: string; body: string }) {
  await Linking.openURL(`mailto:${encodeURIComponent(email.recipient)}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`);
}
