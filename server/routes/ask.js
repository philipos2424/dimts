import express from 'express';
import { HttpError, resolveUser } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';
import { answerQuestion } from '../services/ask.js';
import { briefingAnswer, isPlanningQuestion, weeklyBriefing } from '../services/briefing.js';

export const askRouter = express.Router();

// Questions and answers are not stored: the app keeps the conversation.
askRouter.post('/', async (req, res) => {
  const user = await resolveUser(req);
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (question.length < 3 || question.length > 500) throw new HttpError(400, 'invalid_question', 'Ask a question between 3 and 500 characters.');
  await hit(`ask:${user.id}`, 30, 3600);
  // "What should I do this week?" is answered from stored promises and
  // agreements, not by searching transcripts for those words.
  if (isPlanningQuestion(question)) {
    const briefing = await weeklyBriefing(user.id);
    const citations = briefing.money.filter(m => Number.isInteger(m.line) && m.quote).slice(0, 3)
      .map(m => ({ call_id: m.call_id, contact_name: m.contact_name, created_at: m.created_at, line: m.line, quote: m.quote, start: m.start }));
    return res.json({ answer: briefingAnswer(briefing, user.language), grounded: true, citations });
  }
  res.json(await answerQuestion(user.id, question));
});
