import { Platform } from 'react-native';
import type { Promises } from './api';
import { dueMoment, reminderTime } from './reminderTime';

export const PROMISE_REMINDER = 'promise-reminder';

/**
 * Reminders for promises the owner made live on the phone, so they fire on
 * time without a server schedule and with the phone offline. Every sync
 * replaces the whole set: a promise marked done, dismissed or moved simply
 * stops being scheduled. Only the owner's own promises are reminded.
 */
export async function syncPromiseReminders(promises: Promises) {
  if (Platform.OS === 'web') return;
  const Notifications = await import('expo-notifications');
  const due = promises.you_owe.flatMap(p => {
    const at = p.due && !p.overdue ? reminderTime(p.due) : null;
    return at ? [{ p, at }] : [];
  });

  let permission = await Notifications.getPermissionsAsync();
  // Ask only once there is something to remind, so the prompt makes sense.
  if (permission.status !== 'granted' && due.length && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') return;
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('promise-reminders', {
    name: 'Promise reminders', importance: Notifications.AndroidImportance.HIGH,
  });

  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(scheduled.filter(n => n.content.data?.type === PROMISE_REMINDER)
    .map(n => Notifications.cancelScheduledNotificationAsync(n.identifier)));
  for (const { p, at } of due) {
    // The evening-before reminder falls on an earlier calendar day than the deadline.
    const tomorrow = at.toDateString() !== dueMoment(p.due!)?.toDateString();
    await Notifications.scheduleNotificationAsync({
      identifier: `promise-${p.call_id}-${p.index}`,
      content: {
        title: tomorrow ? 'Due tomorrow' : 'Due soon',
        body: p.contact_name ? `${p.task} (${p.contact_name})` : p.task,
        data: { type: PROMISE_REMINDER, call_id: p.call_id },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: 'promise-reminders' },
    });
  }
}
