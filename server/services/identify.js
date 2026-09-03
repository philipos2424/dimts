import OpenAI from 'openai';
import { config } from '../config.js';

/** People introduce themselves early; the rest of the call is noise here. */
const OPENING_LINES = 12;

export const IDENTIFY_PROMPT = `You extract who the "Caller:" is from the start
of a phone transcript.

Look for a self-introduction such as "this is Phili from Amax", or the User
addressing them by name. Do not guess from the topic of conversation.

Return JSON: { name, company, confidence }.
- name: the caller's personal name, or null if they never gave one.
- company: their organisation, or null.
- confidence: 0 to 1. Use 0 when nobody introduced themselves. Only exceed
  0.7 when the introduction is explicit and unambiguous.

Never invent a name. Absent an introduction, return nulls with confidence 0.`;

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}

export function openingOf(transcript, lines = OPENING_LINES) {
  return String(transcript ?? '')
    .split('\n')
    .slice(0, lines)
    .join('\n');
}

const NO_IDENTITY = { name: null, company: null, confidence: 0 };

/**
 * Identification is best-effort. Unlike the summary parser, which throws so a
 * bad response cannot be written as if it were good, this returns a null
 * identity: failing to name a contact is not worth failing a call over.
 */
export function parseIdentity(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return { ...NO_IDENTITY };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...NO_IDENTITY };
  }

  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
  const company =
    typeof data.company === 'string' && data.company.trim() ? data.company.trim() : null;

  const raw = Number(data.confidence);
  const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;

  return { name, company, confidence: name ? confidence : 0 };
}

export async function identifyCaller(transcript) {
  const completion = await getClient().chat.completions.create({
    model: config.openaiModel,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: IDENTIFY_PROMPT },
      { role: 'user', content: openingOf(transcript) },
    ],
  });

  return parseIdentity(completion.choices[0]?.message?.content ?? '');
}
