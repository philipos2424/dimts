import express from 'express';
import { query, queryOne } from '../db/pool.js';
import { resolveUser, HttpError } from '../lib/users.js';
import { generateFollowups, validateReviewedFollowups } from '../services/followups.js';

export const followupsRouter = express.Router();
async function persist(callId, userId, draft, version, kind, generating = false) {
  return queryOne(`WITH changed AS (
    UPDATE calls SET followups=$3::jsonb, followups_version=followups_version+1
    WHERE id=$1 AND user_id=$2 AND followups_version=$4
      AND ((followups IS NULL AND $6::boolean) OR (followups IS NOT NULL AND NOT $6::boolean))
    RETURNING id, user_id, followups, followups_version
  ), logged AS (
    INSERT INTO followup_events(call_id,user_id,kind,version)
    SELECT id,user_id,$5,followups_version FROM changed RETURNING id
  ) SELECT followups FROM changed`,
  [callId, userId, JSON.stringify({ ...draft, version: version + 1 }), version, kind, generating]);
}
followupsRouter.post('/:id/followups', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne('SELECT id, transcript, followups FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
    if (!call) throw new HttpError(404, 'call_not_found');
    if (call.followups) return res.json(call.followups);
    if (!call.transcript) throw new HttpError(409, 'transcript_not_ready');
    const draft = await generateFollowups(call.transcript);
    const saved = await persist(call.id, user.id, draft, 0, 'generated', true);
    // A simultaneous generation must never overwrite the user's saved edits.
    res.json(saved?.followups ?? (await queryOne('SELECT followups FROM calls WHERE id=$1 AND user_id=$2', [call.id, user.id])).followups);
  } catch (err) { next(err); }
});
followupsRouter.patch('/:id/followups', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const current = await queryOne('SELECT followups, followups_version FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
    if (!current?.followups) throw new HttpError(404, 'followups_not_found');
    if ((req.body?.version ?? 0) !== current.followups_version) throw new HttpError(409, 'draft_changed', 'Reload this call before editing the latest draft.');
    let draft;
    try { draft = validateReviewedFollowups(req.body); }
    catch { throw new HttpError(400, 'invalid_followups', 'Check the email address and UTC meeting times.'); }
    for (const kind of ['email', 'meeting']) {
      const old = current.followups[kind];
      if (old && !draft[kind]) throw new HttpError(400, 'use_reject', 'Use Reject to dismiss a proposal.');
      if (old?.status === 'rejected') draft[kind] = old;
      else if (draft[kind]) {
        draft[kind].evidence = old?.evidence ?? null;
        draft[kind].status = 'pending';
      }
    }
    const saved = await persist(req.params.id, user.id, draft, current.followups_version, 'edited');
    if (!saved) throw new HttpError(409, 'draft_changed', 'Reload the latest draft.');
    res.json(saved.followups);
  } catch (err) { next(err); }
});
followupsRouter.post('/:id/followups/:kind/reject', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const kind = req.params.kind;
    if (!['email', 'meeting'].includes(kind)) throw new HttpError(400, 'invalid_proposal');
    const current = await queryOne('SELECT followups, followups_version FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
    if (!current?.followups?.[kind]) throw new HttpError(404, 'proposal_not_found');
    if (current.followups[kind].status === 'rejected') return res.json(current.followups);
    if ((req.body?.version ?? 0) !== current.followups_version) throw new HttpError(409, 'draft_changed');
    const draft = { ...current.followups, [kind]: { ...current.followups[kind], status: 'rejected' } };
    const saved = await persist(req.params.id, user.id, draft, current.followups_version, `${kind}_rejected`);
    if (!saved) throw new HttpError(409, 'draft_changed');
    res.json(saved.followups);
  } catch (err) { next(err); }
});
followupsRouter.get('/:id/followups/events', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne('SELECT id FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
    if (!call) throw new HttpError(404, 'call_not_found');
    const { rows } = await query('SELECT kind, version, created_at FROM followup_events WHERE call_id=$1 AND user_id=$2 ORDER BY version', [call.id, user.id]);
    res.json({ events: rows });
  } catch (err) { next(err); }
});
