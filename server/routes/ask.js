import express from 'express';
import { capture } from '../lib/analytics.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';
import { answerQuestion } from '../services/ask.js';
import { briefingAnswer, isPlanningQuestion, weeklyBriefing } from '../services/briefing.js';

export const askRouter = express.Router();
export const ASK_TIMEOUT_MS = 25_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Questions and answers are not stored: the app keeps the conversation.
askRouter.post('/', async (req, res) => {
  const user = await resolveUser(req);
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (question.length < 3 || question.length > 500) throw new HttpError(400, 'invalid_question', 'Ask a question between 3 and 500 characters.');
  await hit(`ask:${user.id}`, 30, 3600);
  // Up to two earlier turns from this conversation, so follow-ups make sense.
  const history = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-2)
    .filter(t => typeof t?.question === 'string' && typeof t?.answer === 'string')
    .map(t => ({ question: t.question.slice(0, 500), answer: t.answer.slice(0, 1000),
      call_ids: Array.isArray(t.call_ids) ? t.call_ids.filter(id => typeof id === 'string' && UUID.test(id)).slice(0, 4) : [] }));
  // "What should I do this week?" is answered from stored promises and
  // agreements, not by searching transcripts for those words.
  if (isPlanningQuestion(question)) {
    const briefing = await weeklyBriefing(user.id);
    const citations = briefing.money.filter(m => Number.isInteger(m.line) && m.quote).slice(0, 3)
      .map(m => ({ call_id: m.call_id, contact_name: m.contact_name, created_at: m.created_at, line: m.line, quote: m.quote, start: m.start }));
    return res.json({ answer: briefingAnswer(briefing, user.language), grounded: true, citations });
  }
  const focus = history.at(-1)?.call_ids ?? [];
  // The app gives up after 30 seconds; stop the model before that so the
  // owner gets a clear answer and we stop paying for one nobody will read.
  capture(user.id, 'ask_used');
  try {
    res.json(await answerQuestion(user.id, question, history.map(({ question, answer }) => ({ question, answer })), focus,
      { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) }));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('[ask] model unavailable', err?.name ?? 'Error');
    throw new HttpError(503, 'ai_unavailable', 'Dimts AI is not answering right now. Try again in a minute.');
  }
});
