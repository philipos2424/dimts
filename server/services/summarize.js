import { completeJson } from './llm.js';

/** Verbatim from SPEC.md §6 step 4. */
/** Speaker labels come from the dual-channel transcript merge. */
export const SYSTEM_PROMPT = `You process business phone call transcripts.
The transcript is speaker-labelled: "User:" is the person you work for,
"Caller:" is the other party.

Return JSON:
{
  summary: 3-6 sentences covering what was discussed and agreed,
  next_moves: 2-4 short imperative suggestions for what the User should do
              next, ordered by importance,
  action_items: [{task, owner}] - things someone explicitly committed to,
  key_points: [strings] - facts worth remembering, such as figures, names,
              dates and constraints
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
    summary: data.summary.trim(),
    next_moves: (Array.isArray(data.next_moves) ? data.next_moves : [])
      .map((move) => (typeof move === 'string' ? move.trim() : ''))
      .filter(Boolean),
    action_items: actionItems
      .map((item) =>
        typeof item === 'string'
          ? { task: item, owner: null }
          : { task: item?.task ?? '', owner: item?.owner ?? null }
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
    action_items: summary.action_items.map(item => ({ ...item, task: clean(item.task) })) };
}

export async function summarize(transcript) {
  const result = parseSummary(await completeJson(SYSTEM_PROMPT, transcript, {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      next_moves: { type: 'array', items: { type: 'string' } },
      action_items: { type: 'array', items: { type: 'object',
        properties: { task: { type: 'string' }, owner: { type: ['string', 'null'], enum: ['User', 'Caller', null] } },
        required: ['task', 'owner'], additionalProperties: false } },
      key_points: { type: 'array', items: { type: 'string' } },
    }, required: ['summary', 'next_moves', 'action_items', 'key_points'],
  }));
  return preserveTimeAmbiguity(result, transcript);
}
