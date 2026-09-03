import express from 'express';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { HttpError, currentMonth, resolveUser } from '../lib/users.js';
import { defer } from '../lib/defer.js';
import { fetchRecording, isE164, originateCall } from '../services/originate.js';
import { processRecording } from '../services/process-recording.js';

export const callsRouter = express.Router();

const LIST_COLUMNS = `
  c.id, c.destination, c.status, c.duration_sec, c.direction, c.summary,
  c.created_at, k.display_name AS contact_name, k.company
`;

/**
 * Fail calls that never got answered.
 *
 * If leg A is never picked up, no dial-done and no recording webhook ever
 * arrive, so the row would sit at 'initiating' forever while the app polls it
 * every 5s. Running this on list is cheaper than a cron and is the only place
 * that needs it.
 */
async function reapStaleCalls(userId) {
  await query(
    `UPDATE calls
        SET status = 'failed',
            error = COALESCE(error, 'No answer - call timed out')
      WHERE user_id = $1
        AND status IN ('initiating', 'ringing')
        AND created_at < now() - ($2 || ' minutes')::interval`,
    [userId, String(config.staleCallMinutes)]
  );
}

callsRouter.post('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { destination } = req.body ?? {};

    if (!isE164(destination)) {
      throw new HttpError(
        400,
        'invalid_destination',
        'destination must be an E.164 number, e.g. +251911234567'
      );
    }

    const call = await queryOne(
      `INSERT INTO calls (user_id, user_phone, destination, status)
       VALUES ($1, $2, $3, 'initiating')
       RETURNING id, status`,
      [user.id, user.phone, destination]
    );

    try {
      const sid = await originateCall({
        callId: call.id,
        userPhone: user.phone,
        destination,
      });
      await query('UPDATE calls SET twilio_call_sid = $2 WHERE id = $1', [
        call.id,
        sid,
      ]);
    } catch (err) {
      // Keep the row so the failure is visible in Recents rather than the
      // call vanishing with only a toast.
      await query(
        `UPDATE calls SET status = 'failed', error = $2 WHERE id = $1`,
        [call.id, String(err?.message ?? err).slice(0, 500)]
      );
      throw err;
    }

    res.status(201).json({ callId: call.id, status: call.status });
  } catch (err) {
    next(err);
  }
});

callsRouter.get('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await reapStaleCalls(user.id);

    const { rows } = await query(
      `SELECT ${LIST_COLUMNS} FROM calls c
         LEFT JOIN contacts k ON k.id = c.contact_id
        WHERE c.user_id = $1
        ORDER BY c.created_at DESC
        LIMIT 100`,
      [user.id]
    );

    res.json({ calls: rows });
  } catch (err) {
    next(err);
  }
});

callsRouter.get('/:id', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne(
      `SELECT c.id, c.destination, c.status, c.duration_sec, c.direction,
              c.recording_url, c.transcript, c.summary, c.next_moves,
              c.action_items, c.key_points, c.error, c.created_at,
              k.display_name AS contact_name, k.company
         FROM calls c
         LEFT JOIN contacts k ON k.id = c.contact_id
        WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, user.id]
    );

    if (!call) throw new HttpError(404, 'call_not_found');

    res.json({
      ...call,
      // The app never gets Twilio's URL directly; it would need Twilio
      // credentials to fetch it.
      audio_url: call.recording_url ? `/api/calls/${call.id}/audio` : null,
    });
  } catch (err) {
    next(err);
  }
});

/** Retry hook for a row stuck in 'processing' — safe to call repeatedly. */
callsRouter.post('/:id/process', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne(
      'SELECT id, recording_url FROM calls WHERE id = $1 AND user_id = $2',
      [req.params.id, user.id]
    );

    if (!call) throw new HttpError(404, 'call_not_found');
    if (!call.recording_url) throw new HttpError(409, 'no_recording_yet');

    defer(processRecording(call.id), `reprocess:${call.id}`);
    res.status(202).json({ status: 'processing' });
  } catch (err) {
    next(err);
  }
});

/**
 * Proxies recording media so the app never holds Twilio credentials.
 * expo-audio sends `x-user-phone` via AudioSource headers.
 */
callsRouter.get('/:id/audio', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne(
      'SELECT recording_url FROM calls WHERE id = $1 AND user_id = $2',
      [req.params.id, user.id]
    );

    if (!call?.recording_url) throw new HttpError(404, 'recording_not_found');

    const upstream = await fetchRecording(call.recording_url);
    if (!upstream.ok || !upstream.body) {
      throw new HttpError(502, 'recording_fetch_failed');
    }

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    const length = upstream.headers.get('content-length');
    if (length) res.set('Content-Length', length);

    const { Readable } = await import('node:stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    next(err);
  }
});

export const usageRouter = express.Router();

usageRouter.get('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const month = currentMonth();

    const row = await queryOne(
      'SELECT minutes_used FROM usage_minutes WHERE user_id = $1 AND month = $2',
      [user.id, month]
    );

    res.json({
      month,
      tier: user.tier,
      minutes_used: Number(row?.minutes_used ?? 0),
    });
  } catch (err) {
    next(err);
  }
});

export const meRouter = express.Router();

/** The app needs to know which number to tell the user to publish. */
meRouter.get('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const row = await queryOne(
      'SELECT id, phone, tier, agent_number FROM users WHERE id = $1',
      [user.id]
    );

    res.json({
      phone: row.phone,
      tier: row.tier,
      agent_number: row.agent_number ?? null,
    });
  } catch (err) {
    next(err);
  }
});
