import { completeJson } from './llm.js';

export const FOLLOWUP_PROMPT = `Create follow-up drafts for the User from a phone transcript.
Return {email: {subject, body} or null, meeting: {title, notes, time_text} or null}.
Write an email only when a follow-up email is useful. Write it from User's perspective;
do not promise work that Caller committed to doing. Never invent prices or attachments.
Propose a meeting only if User agreed to it. Preserve the exact spoken date/time in
time_text, including ambiguity. Do not resolve relative dates, AM/PM or timezone.
Missing details belong in notes. Do not invent email addresses. These are drafts
for review, not authorization to send an email or create an event.`;

export function parseFollowups(content) {
  const data = JSON.parse(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid follow-up result');
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
  return parseFollowups(await completeJson(FOLLOWUP_PROMPT, transcript, {
    type: 'object', properties: {
      email: { type: ['object', 'null'], properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] },
      meeting: { type: ['object', 'null'], properties: { title: { type: 'string' }, notes: { type: 'string' }, time_text: { type: 'string' } }, required: ['title', 'notes', 'time_text'] },
    }, required: ['email', 'meeting'],
  }));
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
