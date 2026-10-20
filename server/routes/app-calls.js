import express from 'express';
import { HttpError, resolveUser } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';
import { getIceServers } from '../services/turn.js';
import { addSignal, answerAppCall, declineAppCall, endAppCall, getAppCallStatus, hasLiveAppCall, heartbeat, incomingAppCall, listSignals, reportConnected } from '../services/app-calls.js';

// Starting a call is internal (POST /api/calls calls startAppCall); this router
// only carries what happens after a call exists.
export const appCallsRouter = express.Router();

const SIGNAL_KINDS = ['offer', 'answer', 'candidate', 'recording-stopped'];
const MAX_PAYLOAD_BYTES = 16 * 1024;
const handler = work => async (req, res, next) => {
  try { res.json(await work(await resolveUser(req), req)); } catch (err) { next(err); }
};

// Clients never post 'bye': ending and declining write it, so a peer cannot fake hang-ups.
// The surface does not exist until the feature is switched on.
appCallsRouter.use((req, res, next) => process.env.APP_CALLS_ENABLED === 'true' ? next() : res.status(404).json({ error: 'not_found' }));

appCallsRouter.get('/ice', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await hit(`app-ice:${user.id}`, 30, 600);
    if (!(await hasLiveAppCall(user))) throw new HttpError(404, 'app_call_not_found');
    res.json({ iceServers: await getIceServers() });
  } catch (err) {
    if (err?.code === 'turn_unavailable') return res.status(503).json({ error: 'turn_unavailable', code: 'turn_unavailable' });
    next(err);
  }
});

appCallsRouter.get('/incoming', handler(user => incomingAppCall(user)));
appCallsRouter.get('/:id', handler((user, req) => getAppCallStatus(user, req.params.id)));

appCallsRouter.post('/:id/signals', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await hit(`app-signal:${user.id}`, 600, 600);
    const { kind, payload } = req.body ?? {};
    if (!SIGNAL_KINDS.includes(kind)) throw new HttpError(400, 'invalid_kind');
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'invalid_signal_payload');
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw new HttpError(400, 'signal_too_large');
    res.status(201).json(await addSignal(user, req.params.id, kind, payload));
  } catch (err) { next(err); }
});

appCallsRouter.get('/:id/signals', handler((user, req) => {
  const raw = req.query.after;
  if (raw !== undefined && !/^\d{1,15}$/.test(String(raw))) throw new HttpError(400, 'invalid_cursor');
  return listSignals(user, req.params.id, raw === undefined ? 0 : Number(raw));
}));

appCallsRouter.post('/:id/heartbeat', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await hit(`app-heartbeat:${user.id}`, 30, 60);
    res.json(await heartbeat(user, req.params.id));
  } catch (err) { next(err); }
});

appCallsRouter.post('/:id/answer', handler((user, req) => answerAppCall(user, req.params.id)));
appCallsRouter.post('/:id/decline', handler((user, req) => declineAppCall(user, req.params.id)));
appCallsRouter.post('/:id/connected', handler((user, req) => {
  const hash = req.body?.fingerprintHash;
  if (hash !== undefined && (typeof hash !== 'string' || hash.length > 200)) throw new HttpError(400, 'invalid_fingerprint');
  return reportConnected(user, req.params.id);
}));
appCallsRouter.post('/:id/end', handler((user, req) => {
  const seconds = req.body?.seconds;
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new HttpError(400, 'invalid_seconds');
  return endAppCall(user, req.params.id, seconds);
}));
