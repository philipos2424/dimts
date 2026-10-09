/**
 * When to remind the owner about a promise they made. `due` is the deadline
 * in their local time, as the server stores it: "2026-10-08T12:00" or a bare
 * "2026-10-09". The phone's clock is the owner's clock, so local Date
 * arithmetic is correct here.
 *
 * The reminder goes out at 6 pm the evening before. A promise made too late
 * for that ("by 5 today") is reminded 2 hours before its time instead, or at
 * 9 am on the day for a bare date, so no deadline passes unannounced.
 */
export const EVENING_HOUR = 18;
const DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

export function dueMoment(due: string): Date | null {
  const m = DUE.exec(due);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  // A bare date is due by the end of that day.
  return h ? new Date(+y, +mo - 1, +d, +h, +mi) : new Date(+y, +mo - 1, +d, 23, 59);
}

export function reminderTime(due: string, now: Date = new Date()): Date | null {
  const at = dueMoment(due);
  if (!at || at <= now) return null;
  const evening = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1, EVENING_HOUR, 0);
  if (evening > now) return evening;
  const timed = /T/.test(due);
  const fallback = timed ? new Date(at.getTime() - 2 * 3_600_000) : new Date(at.getFullYear(), at.getMonth(), at.getDate(), 9, 0);
  return fallback > now ? fallback : null;
}

/** "Today 12:00", "Tomorrow", "Fri 9 Oct 15:00": short enough for a promise row. */
export function dueLabel(due: string, now: Date = new Date()): string | null {
  const at = dueMoment(due);
  if (!at) return null;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(now)) / 86_400_000);
  const time = /T/.test(due) ? ` ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '';
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday'
    : at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}${time}`;
}
