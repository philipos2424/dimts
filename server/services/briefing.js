import { query, queryOne } from '../db/pool.js';
import { listPromises } from '../routes/promises.js';

// Money first: anything that mentions an amount, a price or a payment.
const MONEY = /(\d|[$€£]|\bbirr\b|ብር|\bpay|\bpaid|\bowe|invoice|deposit|balance|price|quote|ክፍያ|ዋጋ|ገንዘብ)/i;
const DAY = 86_400_000;

const ageDays = (date, now) => Math.max(0, Math.floor((now - new Date(date)) / DAY));
// Money items first, then the oldest: the longer a promise waits, the more it slips.
const rank = (items, now) => items
  .map(item => ({ ...item, age_days: ageDays(item.created_at, now), money: MONEY.test(item.task ?? '') }))
  .sort((a, b) => Number(b.money) - Number(a.money) || b.age_days - a.age_days);

/**
 * What needs attention this week, built only from facts already stored on the
 * owner's calls: open promises, agreed prices and amounts (each with its quote
 * and moment), contradictions and suggested next steps. No model call, so it
 * is cheap enough to compute on every open and for a weekly notification.
 */
export async function weeklyBriefing(userId, now = new Date()) {
  const recent = `c.user_id=$1 AND c.status='ready' AND c.deleted_at IS NULL AND c.created_at > $2::timestamptz`;
  const weekAgo = new Date(now - 7 * DAY), twoWeeksAgo = new Date(now - 14 * DAY);

  const activity = await queryOne(`SELECT count(*)::int AS calls, coalesce(sum(duration_sec),0)::int AS seconds
    FROM calls c WHERE ${recent}`, [userId, weekAgo]);

  const { rows: money } = await query(`SELECT c.id AS call_id, c.created_at, c.contact_id, k.display_name AS contact_name,
      a.value->>'kind' AS kind, a.value->>'subject' AS subject, a.value->>'value' AS value,
      a.value->>'quote' AS quote, (a.value->>'line')::int AS line, (a.value->>'start')::float AS start
    FROM calls c
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.agreements)='array' THEN c.agreements ELSE '[]'::jsonb END) a(value)
    LEFT JOIN contacts k ON k.id = c.contact_id
    WHERE ${recent} AND a.value->>'kind' IN ('amount','price')
    ORDER BY c.created_at DESC LIMIT 6`, [userId, twoWeeksAgo]);

  const { rows: conflicts } = await query(`SELECT c.id AS call_id, c.created_at, k.display_name AS contact_name,
      jsonb_array_length(c.conflicts) AS count, c.conflicts->0->>'note' AS note
    FROM calls c LEFT JOIN contacts k ON k.id = c.contact_id
    WHERE ${recent} AND jsonb_typeof(c.conflicts)='array' AND jsonb_array_length(c.conflicts) > 0
    ORDER BY c.created_at DESC LIMIT 5`, [userId, twoWeeksAgo]);

  const { rows: nextMoves } = await query(`SELECT c.id AS call_id, c.created_at, k.display_name AS contact_name,
      c.next_moves->>0 AS move
    FROM calls c LEFT JOIN contacts k ON k.id = c.contact_id
    WHERE ${recent} AND jsonb_typeof(c.next_moves)='array' AND jsonb_array_length(c.next_moves) > 0
    ORDER BY c.created_at DESC LIMIT 5`, [userId, weekAgo]);

  const promises = await listPromises(userId);
  const youOwe = rank(promises.you_owe, now), waitingOn = rank(promises.waiting_on, now);

  return {
    since: weekAgo.toISOString(),
    calls_this_week: activity.calls,
    minutes_this_week: Math.round(activity.seconds / 60),
    money,
    you_owe: youOwe.slice(0, 5),
    waiting_on: waitingOn.slice(0, 5),
    conflicts: conflicts.map(row => ({ ...row, count: Number(row.count) })),
    next_moves: nextMoves.filter(row => row.move),
    totals: { you_owe: youOwe.length, waiting_on: waitingOn.length, money: money.length, conflicts: conflicts.length },
  };
}

export const briefingIsEmpty = b => !b.totals.you_owe && !b.totals.waiting_on && !b.totals.money && !b.totals.conflicts && !b.next_moves.length;

const TEXT = {
  en: {
    owe: (who, task) => `You promised ${who}: ${task}`,
    waiting: (who, task, days) => `${who} promised you: ${task}${days ? ` (${days} days ago)` : ''}`,
    money: (who, subject, value) => `${who} — ${subject}: ${value}`,
    conflict: (who, note) => `Check ${who}: ${note}`,
    move: (who, move) => `${who}: ${move}`,
    someone: 'someone',
    empty: 'Nothing is waiting on you from recent calls.',
    heading: 'This week',
    push: (owe, waiting, money) => [owe && `${owe} promise${owe === 1 ? '' : 's'} to keep`, waiting && `${waiting} to chase`,
      money && `${money} price${money === 1 ? '' : 's'} agreed`].filter(Boolean).join(' · '),
  },
  am: {
    owe: (who, task) => `ለ${who} ቃል የገቡት፦ ${task}`,
    waiting: (who, task, days) => `${who} ቃል የገባልዎት፦ ${task}${days ? ` (ከ${days} ቀን በፊት)` : ''}`,
    money: (who, subject, value) => `${who} — ${subject}፦ ${value}`,
    conflict: (who, note) => `${who}ን ያረጋግጡ፦ ${note}`,
    move: (who, move) => `${who}፦ ${move}`,
    someone: 'አንድ ሰው',
    empty: 'ከቅርብ ጥሪዎች የሚጠብቅዎት ነገር የለም።',
    heading: 'በዚህ ሳምንት',
    push: (owe, waiting, money) => [owe && `${owe} የሚጠብቁ ቃሎች`, waiting && `${waiting} የሚከታተሉ`, money && `${money} የተስማሙ ዋጋዎች`]
      .filter(Boolean).join(' · '),
  },
};
export const briefingText = lang => TEXT[lang] ?? TEXT.en;

/** A short, plain answer to "what should I do this week?", money first. */
export function briefingAnswer(b, lang = 'en') {
  const t = briefingText(lang), who = name => name || t.someone;
  const lines = [
    ...b.you_owe.slice(0, 3).map(p => t.owe(who(p.contact_name), p.task)),
    ...b.waiting_on.slice(0, 3).map(p => t.waiting(who(p.contact_name), p.task, p.age_days)),
    ...b.conflicts.slice(0, 2).map(c => t.conflict(who(c.contact_name), c.note)),
    ...b.money.slice(0, 3).map(m => t.money(who(m.contact_name), m.subject, m.value)),
  ];
  if (!lines.length) lines.push(...b.next_moves.slice(0, 3).map(m => t.move(who(m.contact_name), m.move)));
  return lines.length ? `${t.heading}:\n${lines.map(l => `• ${l}`).join('\n')}` : t.empty;
}

// "What should I do this week?", "what's due", "ምን ላድርግ" and similar.
export const isPlanningQuestion = q =>
  /\b(this week|today|to-?do|due|what (should|shall|do|must) i do|what('s| is) (next|pending|waiting)|priorit|remind me|follow.?ups?)\b/i.test(q) ||
  /(በዚህ ሳምንት|ዛሬ|ምን ላድርግ|ምን ማድረግ|ምን ይጠብቀኛል)/.test(q);
