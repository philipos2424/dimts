import OpenAI from 'openai';
import { config } from '../config.js';

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
If the call was too short or unclear to summarize, say so in summary and
return empty arrays.`;

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey });
  return client;
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

export async function summarize(transcript) {
  const completion = await getClient().chat.completions.create({
    model: config.openaiModel,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
  });

  return parseSummary(completion.choices[0]?.message?.content ?? '');
}
