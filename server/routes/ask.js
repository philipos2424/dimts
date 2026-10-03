import express from 'express';
import { HttpError, resolveUser } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';
import { answerQuestion } from '../services/ask.js';

export const askRouter = express.Router();

// Questions and answers are not stored: the app keeps the conversation.
askRouter.post('/', async (req, res) => {
  const user = await resolveUser(req);
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (question.length < 3 || question.length > 500) throw new HttpError(400, 'invalid_question', 'Ask a question between 3 and 500 characters.');
  await hit(`ask:${user.id}`, 30, 3600);
  res.json(await answerQuestion(user.id, question));
});
