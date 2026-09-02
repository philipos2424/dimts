import OpenAI from 'openai';
import { config } from '../config.js';

/** Verbatim from SPEC.md §6 step 4. */
export const SYSTEM_PROMPT = `You process phone call transcripts for an Ethiopian audience.
The transcript may be in Amharic, English, or a mix.
Return JSON: { language, summary (3-6 sentences in the call's dominant
language), action_items: [{task, owner}], key_points: [strings] }.
Never invent facts. Keep names exactly as transcribed.`;

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
    language: typeof data.language === 'string' ? data.language : null,
    summary: data.summary.trim(),
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
