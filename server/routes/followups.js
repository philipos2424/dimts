import express from 'express';
import { queryOne } from '../db/pool.js';
import { resolveUser, HttpError } from '../lib/users.js';
import { generateFollowups, validateReviewedFollowups } from '../services/followups.js';

export const followupsRouter = express.Router();
followupsRouter.post('/:id/followups', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne('SELECT id, transcript, followups FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
    if (!call) throw new HttpError(404, 'call_not_found');
    if (call.followups) return res.json(call.followups);
    if (!call.transcript) throw new HttpError(409, 'transcript_not_ready');
    const draft = await generateFollowups(call.transcript);
    const saved = await queryOne(`UPDATE calls SET followups=$3::jsonb WHERE id=$1 AND user_id=$2 AND followups IS NULL RETURNING followups`,
      [call.id, user.id, JSON.stringify(draft)]);
    // A simultaneous generation must never overwrite the user's saved edits.
    res.json(saved?.followups ?? (await queryOne('SELECT followups FROM calls WHERE id=$1 AND user_id=$2', [call.id, user.id])).followups);
  } catch (err) { next(err); }
});
followupsRouter.patch('/:id/followups', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    let draft;
    try { draft = validateReviewedFollowups(req.body); }
    catch { throw new HttpError(400, 'invalid_followups', 'Check the email address and UTC meeting times.'); }
    const saved = await queryOne('UPDATE calls SET followups=$3::jsonb WHERE id=$1 AND user_id=$2 AND followups IS NOT NULL RETURNING followups',
      [req.params.id, user.id, JSON.stringify(draft)]);
    if (!saved) throw new HttpError(404, 'followups_not_found');
    res.json(saved.followups);
  } catch (err) { next(err); }
});
