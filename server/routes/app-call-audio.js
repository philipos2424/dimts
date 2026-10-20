import express from 'express';
import { HttpError, resolveUser } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';
import { MAX_PART_BYTES, completeOwnAudio, storeAudioPart } from '../services/app-call-audio.js';

// After an app call each phone uploads its owner's own voice here, in parts.
// Mounted on /api/calls; every route is gated on its own so the rest of
// /api/calls is untouched when the feature is off.
export const appCallAudioRouter = express.Router();

const enabled = (_req, res, next) => process.env.APP_CALLS_ENABLED === 'true' ? next() : res.status(404).json({ error: 'not_found' });
const signedIn = async (req, _res, next) => {
  try {
    req.user = await resolveUser(req);
    await hit(`app-audio:${req.user.id}`, 120, 600);
    next();
  } catch (err) { next(err); }
};
// Only this route takes a raw body, and only after the flag and sign-in
// checks. Any content type is accepted: the bytes are the audio.
const rawPart = express.raw({ type: () => true, limit: MAX_PART_BYTES });
const tooLarge = (err, _req, _res, next) => next(err?.type === 'entity.too.large'
  ? new HttpError(413, 'part_too_large', 'Each part must be at most 1 MiB.') : err);
const integer = value => /^\d{1,3}$/.test(String(value ?? '')) ? Number(value) : NaN;

appCallAudioRouter.put('/:id/audio-part', enabled, signedIn, rawPart, tooLarge, async (req, res, next) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body) throw new HttpError(400, 'invalid_part', 'Send the part as raw bytes.');
    res.json(await storeAudioPart(req.user, req.params.id, { index: integer(req.query.index), total: integer(req.query.total),
      sha256: req.get('x-part-sha256'), body }));
  } catch (err) { next(err); }
});

appCallAudioRouter.post('/:id/audio-complete', enabled, signedIn, async (req, res, next) => {
  try {
    res.json(await completeOwnAudio(req.user, req.params.id, { offsetMs: req.body?.offsetMs, mime: req.body?.mime }));
  } catch (err) { next(err); }
});
