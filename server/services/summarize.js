import { completeJson } from './llm.js';

/** Verbatim from SPEC.md §6 step 4. */
/** Speaker labels come from the dual-channel transcript merge. */
export const SYSTEM_PROMPT = `You process business phone call transcripts.
The transcript is speaker-labelled: "User:" is the person you work for,
"Caller:" is the other party.

Return JSON:
{
  summary: 2-5 short, plain sentences written the way you would tell the
           User about the call afterwards ("Abebe agreed to 450 birr a bag
           and will pay the 1,200 balance by Friday."). Start with money and
           commitments: amounts, prices, who owes whom, deadlines. Then the
           rest of what was discussed,
  next_moves: 2-4 short imperative suggestions for what the User should do
              next, ordered by importance,
  action_items: [{task, owner, due}] - things someone explicitly committed to.
                due is when it must be done, in the User's local time:
                "YYYY-MM-DDTHH:MM" when a clear time was said ("by noon
                tomorrow", "at 15:00 Friday"), "YYYY-MM-DD" when only a day
                was said or the time is ambiguous ("by Friday", "at 5"),
                null when no deadline was said. Work out relative days
                ("tomorrow", "next Monday", "end of the week" = Friday) from
                the call date given before the transcript.
  key_points: [strings] - facts worth remembering, such as figures, names,
              dates and constraints,
  agreements: [{kind, subject, value, said_by, source_lines}] - specific
              facts both people settled on or one person stated as a
              commitment: prices, quantities, dates, times, amounts and
              deliverables. kind is one of price, quantity, date, time,
              amount, deliverable, other. subject says what the value is
              about; value is the figure or date as spoken. said_by is
              "User" or "Caller". source_lines are the 1-based numbers of
              the transcript lines where it was said. At most 12.
}

Never invent facts. Keep names, companies and numbers exactly as transcribed.
Include every explicit commitment in action_items, including commitments made
by Caller. owner must be "User" or "Caller" when labelled, otherwise null.
next_moves are useful actions for User only. Never tell User to fulfil a
commitment that Caller made. A confirmed meeting and promised email are
explicit commitments. Separate confirmed agreements from suggestions.
Do not add AM or PM, a timezone, a date, a recipient address or a duration
when the speakers did not specify them. Preserve ambiguous times as ambiguous.
If the call was too short or unclear to summarize, say so in summary and
return empty arrays.`;

const LANGUAGES = { en: 'English', am: 'Amharic' };

/** The owner reads notes in their own language, whatever language was spoken. */
export function summaryPrompt(language) {
  const name = LANGUAGES[language] ?? LANGUAGES.en;
  return `${SYSTEM_PROMPT}
Write summary, next_moves, key_points, action_items.task and agreements.subject in ${name}.
Keep agreements.value, names and numbers exactly as spoken.
The transcript lines are numbered like "[3] Caller: ..."; source_lines refer to those numbers.`;
}

/**
 * Coerce the model's JSON into the shape the database and app expect.
 *
 * JSON mode guarantees parseable JSON, not the right *fields* — a malformed
 * result must throw rather than write half-populated garbage into a call row
 * that the UI will then render as "ready".
 */
export function parseSummary(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(`Summary was not valid JSON: ${String(content).slice(0, 200)}`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Summary JSON was not an object');
  }
  if (typeof data.summary !== 'string' || data.summary.trim() === '') {
    throw new Error('Summary JSON is missing a non-empty "summary"');
  }

  const actionItems = Array.isArray(data.action_items) ? data.action_items : [];

  return {
    agreements: Array.isArray(data.agreements) ? data.agreements : [],
    summary: data.summary.trim(),
    next_moves: (Array.isArray(data.next_moves) ? data.next_moves : [])
      .map((move) => (typeof move === 'string' ? move.trim() : ''))
      .filter(Boolean),
    action_items: actionItems
      .map((item) =>
        typeof item === 'string'
          ? { task: item, owner: null, due: null }
          : { task: item?.task ?? '', owner: item?.owner ?? null, due: cleanDue(item?.due) }
      )
      .filter((item) => item.task),
    key_points: (Array.isArray(data.key_points) ? data.key_points : [])
      .map((point) => (typeof point === 'string' ? point : String(point ?? '')))
      .filter(Boolean),
  };
}

export function preserveTimeAmbiguity(summary, transcript) {
  if (/\b(?:[ap]\.?m\.?|morning|afternoon|evening|noon|midnight)\b/i.test(transcript)) return summary;
  const clean = value => value.replace(/\b(\d{1,2}(?::\d{2})?)\s*[ap]\.?m\.?\b/gi, '$1 (AM/PM not specified)');
  return { ...summary, summary: clean(summary.summary),
    next_moves: summary.next_moves.map(clean), key_points: summary.key_points.map(clean),
    action_items: summary.action_items.map(item => ({ ...item, task: clean(item.task) })),
    agreements: (summary.agreements ?? []).map(item => (item && typeof item === 'object' && typeof item.value === 'string'
      ? { ...item, value: clean(item.value) } : item)) };
}

const DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** A real calendar date (and time), or null: the model's due dates are checked, never trusted. */
export function cleanDue(value) {
  const m = typeof value === 'string' ? DUE.exec(value.trim()) : null;
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  const real = date.getUTCFullYear() === +y && date.getUTCMonth() === +mo - 1 && date.getUTCDate() === +d
    && date.getUTCHours() === +h && date.getUTCMinutes() === +mi;
  return real ? value.trim() : null;
}

/** "Call date: Wednesday 7 October 2026 at 14:30", in the owner's time zone, so relative deadlines resolve. */
export function callDateLine(callTime, timezone) {
  if (!callTime) return null;
  let zone = 'UTC';
  try { if (timezone) { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }); zone = timezone; } } catch { /* stored zones are validated; fall back */ }
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(callTime));
  return `Call date: ${when} (the User's local time)`;
}

export async function summarize(transcript, { language, callTime, timezone, ...options } = {}) {
  const dateLine = callDateLine(callTime, timezone);
  const numbered = (dateLine ? `${dateLine}\n\n` : '') + transcript.split('\n').map((line, i) => `[${i + 1}] ${line}`).join('\n');
  const result = parseSummary(await completeJson(summaryPrompt(language), numbered, {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      next_moves: { type: 'array', items: { type: 'string' } },
      action_items: { type: 'array', items: { type: 'object',
        properties: { task: { type: 'string' }, owner: { type: ['string', 'null'], enum: ['User', 'Caller', null] },
          due: { type: ['string', 'null'] } },
        required: ['task', 'owner', 'due'], additionalProperties: false } },
      key_points: { type: 'array', items: { type: 'string' } },
      agreements: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { kind: { type: 'string' }, subject: { type: 'string' }, value: { type: 'string' },
          said_by: { type: ['string', 'null'] }, source_lines: { type: 'array', items: { type: 'integer' } } },
        required: ['kind', 'subject', 'value', 'said_by', 'source_lines'] } },
    }, required: ['summary', 'next_moves', 'action_items', 'key_points', 'agreements'],
  }, options));
  return preserveTimeAmbiguity(result, transcript);
}
