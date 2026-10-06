import express from 'express';
import { queryOne } from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';
import { completeJson } from '../services/llm.js';
import { sealText } from '../lib/field-crypto.js';

export const recapRouter = express.Router();

const LANGUAGES = { en: 'English', am: 'Amharic' };
const prompt = language => `Write a short follow-up message the user can send to the person they just spoke with.
Use 3 to 6 short lines in ${LANGUAGES[language] ?? 'English'}: a greeting, what was agreed as bullet points,
next steps, and a sign-off. Use only the facts given. Do not add prices, dates, names
or promises that are not listed. Keep values exactly as written.
Return JSON: {"text": "..."}.`;

// Built from the structured notes only: the transcript and private notes never
// reach the recap, so nothing said off-hand can leak into a message.
function facts(call) {
  const agreements = (Array.isArray(call.agreements) ? call.agreements : []).map(a => `- ${a.subject}: ${a.value}`);
  const promises = (Array.isArray(call.action_items) ? call.action_items : [])
    .filter(item => item?.task).map(item => `- ${item.owner === 'Caller' ? 'They will' : item.owner === 'User' ? 'I will' : 'To do'}: ${item.task}`);
  return [`Summary: ${call.summary ?? ''}`, 'Agreed:', ...(agreements.length ? agreements : ['- (none)']),
    'Next steps:', ...(promises.length ? promises : ['- (none)'])].join('\n');
}

recapRouter.post('/:id/recap', async (req, res) => {
  const user = await resolveUser(req);
  const call = await queryOne(`SELECT id,status,summary,agreements,action_items,recap FROM calls
    WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [req.params.id, user.id]);
  if (!call) throw new HttpError(404, 'call_not_found');
  if (call.status !== 'ready') throw new HttpError(409, 'call_not_ready', 'The notes for this call are not ready yet.');
  if (call.recap && req.query.refresh !== '1') return res.json({ text: call.recap });
  await hit(`recap:${user.id}`, 20, 3600);
  let text;
  try {
    const reply = JSON.parse(await completeJson(prompt(user.language), facts(call)));
    if (typeof reply?.text !== 'string' || !reply.text.trim()) throw new Error('No recap text');
    text = reply.text.trim().slice(0, 1500);
  } catch (err) {
    console.error('[recap] generation failed', err?.message);
    throw new HttpError(502, 'recap_failed', 'Could not write a recap. Try again.');
  }
  await queryOne('UPDATE calls SET recap=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id', [call.id, sealText(text, { userId: user.id, rowId: call.id, field: 'calls:recap' })]);
  res.json({ text });
});
