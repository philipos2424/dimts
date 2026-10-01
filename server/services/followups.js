import { completeJson } from './llm.js';

export const FOLLOWUP_PROMPT = `Create follow-up drafts for the User from a phone transcript.
Return {email: {subject, body, evidence} or null, meeting: {title, notes, time_text, evidence} or null}.
Each evidence is {source_lines: [transcript line numbers], confidence: number from 0 to 1, reason: short explanation}.
Choose one to three supporting line numbers. Do not write or paraphrase quotes.
For a meeting, cite both Caller proposing and User accepting, using their line numbers.
Write an email only when a follow-up email is useful. Write it from User's perspective;
do not promise work that Caller committed to doing. Never invent prices or attachments.
Propose a meeting only if User agreed to it. Preserve the exact spoken date/time in
time_text, including ambiguity. Do not resolve relative dates, AM/PM or timezone.
Missing details belong in notes. Do not invent email addresses. These are drafts
for review, not authorization to send an email or create an event.`;

export function parseFollowups(content) {
  const data = JSON.parse(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid follow-up result');
  if (!Object.hasOwn(data, 'email') || !Object.hasOwn(data, 'meeting')) throw new Error('Missing follow-up fields');
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max) throw new Error('Invalid follow-up field');
    return value.trim();
  };
  return {
    email: data.email == null ? null : {
      subject: text(data.email.subject, 200), body: text(data.email.body, 10000), recipient: '',
    },
    meeting: data.meeting == null ? null : {
      title: text(data.meeting.title, 200), notes: text(data.meeting.notes, 5000),
      time_text: text(data.meeting.time_text, 500), start: '', end: '',
    },
  };
}

export async function generateFollowups(transcript) {
  const evidence = { type: 'object', properties: {
    source_lines: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 3 },
    confidence: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string' },
  }, required: ['source_lines', 'confidence', 'reason'] };
  const numbered = transcript.split('\n').map((line, i) => `[${i + 1}] ${line}`).join('\n');
  return parseGeneratedFollowups(await completeJson(FOLLOWUP_PROMPT, numbered, {
    type: 'object', properties: {
      email: { type: ['object', 'null'], properties: { subject: { type: 'string' }, body: { type: 'string' }, evidence }, required: ['subject', 'body', 'evidence'] },
      meeting: { type: ['object', 'null'], properties: { title: { type: 'string' }, notes: { type: 'string' }, time_text: { type: 'string' }, evidence }, required: ['title', 'notes', 'time_text', 'evidence'] },
    }, required: ['email', 'meeting'],
  }), transcript);
}

export function parseGeneratedFollowups(content, transcript) {
  const raw = JSON.parse(content);
  const draft = parseFollowups(content);
  for (const kind of ['email', 'meeting']) {
    if (!draft[kind]) continue;
    let evidence = raw[kind].evidence;
    if (evidence?.source_lines !== undefined) {
      const lines = transcript.split('\n');
      const refs = evidence.source_lines;
      if (!Array.isArray(refs) || refs.length < 1 || refs.length > 3 ||
        refs.some(n => !Number.isInteger(n) || n < 1 || n > lines.length)) throw new Error('Invalid transcript line reference');
      evidence = { ...evidence, quotes: refs.map(n => lines[n - 1]) };
    }
    if (!evidence || !Array.isArray(evidence.quotes) || evidence.quotes.length < 1 || evidence.quotes.length > 3 ||
      evidence.quotes.some(q => typeof q !== 'string' || q.length < 5 || q.length > 2000 || !transcript.includes(q)) ||
      typeof evidence.confidence !== 'number' || !Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1 ||
      typeof evidence.reason !== 'string' || !evidence.reason.trim() || evidence.reason.length > 1000) throw new Error('Follow-up evidence is not supported by the transcript');
    const quoted = evidence.quotes.join('\n');
    if (kind === 'meeting' && (!/(?:^|\n)User:/.test(quoted) || !/(?:^|\n)Caller:/.test(quoted))) throw new Error('Meeting evidence needs both speakers');
    draft[kind].evidence = { quotes: evidence.quotes, confidence: evidence.confidence, reason: evidence.reason.trim() };
    draft[kind].status = 'pending';
  }
  return draft;
}

export function validateReviewedFollowups(input) {
  const result = parseFollowups(JSON.stringify(input));
  if (result.email) {
    const recipient = input.email.recipient;
    if (typeof recipient !== 'string' || recipient.length > 254 ||
        (recipient && !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(recipient))) throw new Error('Invalid recipient');
    result.email.recipient = recipient;
  }
  if (result.meeting) {
    for (const field of ['start', 'end']) {
      const value = input.meeting[field];
      if (typeof value !== 'string' || (value && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
          !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace('.000Z', 'Z') !== value))) throw new Error('Use a valid UTC date and time');
      result.meeting[field] = value;
    }
    if (result.meeting.start && result.meeting.end && Date.parse(result.meeting.end) <= Date.parse(result.meeting.start)) throw new Error('End must be after start');
  }
  return result;
}
