import { captureCallFailure } from '../lib/sentry.js';
import express from 'express';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { HttpError, currentMonth, resolveUser } from '../lib/users.js';
import { defer } from '../lib/defer.js';
import { fetchRecording, isE164, originateCall } from '../services/originate.js';
import { recordingChannels } from '../lib/recording-channels.js';
import { processRecording } from '../services/process-recording.js';
import { reserveCall } from '../db/reserve-call.js';
import { expireRecordingWait } from '../db/expire-recording-wait.js';
import { callNotes } from '../lib/call-export.js';
import { expireProcessing } from '../db/expire-processing.js';
import { transcriptTurns } from '../lib/transcript-turns.js';
import { hasRecordingAuthorization } from '../lib/recording-policy.js';
import { reconcileCall } from '../services/end-call.js';
import { checkCallDestination } from '../services/call-preflight.js';
import { canCall } from '../lib/destinations.js';
import { getAudio } from '../services/audio-store.js';
import { captureState, todayCard } from '../lib/today.js';
import { scheduleArchiveRetries } from '../services/archive-audio.js';
import { audit } from '../lib/audit.js';
import { isReviewDemo } from '../lib/review-demo.js';
import { createReviewDemoCall } from '../services/review-demo.js';

export const callsRouter = express.Router();

const LIST_COLUMNS = `
  c.id, c.destination, c.status, c.duration_sec, c.direction, c.summary,
  c.created_at, k.display_name AS contact_name, k.company, c.contact_id,
  c.followups, c.next_moves, c.error, c.agreements, c.conflicts, c.voicemail,
  (c.recording_url IS NOT NULL OR c.audio_object_key IS NOT NULL) AS has_audio
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
  await expireRecordingWait(userId);
  await expireProcessing(userId);
  const stale = await query(
    `UPDATE calls
        SET status = 'failed',
            error = COALESCE(error, 'No answer - call timed out')
      WHERE user_id = $1
        AND status IN ('initiating', 'ringing')
        AND created_at < now() - ($2 || ' minutes')::interval RETURNING id`,
    [userId, String(config.staleCallMinutes)]
  );
  for (const row of stale.rows) captureCallFailure(new Error('Call timed out'), { callId: row.id, userId, stage: 'call' });
}

callsRouter.post('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { destination, record = true } = req.body ?? {};
    const requestKey = req.get('Idempotency-Key');
    if (!requestKey || !/^[a-zA-Z0-9_-]{8,120}$/.test(requestKey)) throw new HttpError(400, 'request_key_required', 'A valid Idempotency-Key is required.');
    if (typeof record !== 'boolean') throw new HttpError(400, 'invalid_recording_option');
    if ([user.phone, user.agent_number, config.carrierNumber].includes(destination)) {
      throw new HttpError(400, 'call_loop', 'Choose a different destination from your own handset and Twilio number.');
    }

    if (!isE164(destination)) {
      throw new HttpError(
        400,
        'invalid_destination',
        'destination must be an E.164 number, e.g. +251911234567'
      );
    }
    // The review account's number is fictional: file sample notes, ring no one.
    if (isReviewDemo(user.phone)) {
      const call = await createReviewDemoCall(user, destination);
      return res.status(201).json({ callId: call.id, status: call.status });
    }
    // Toll fraud dials premium and unserved countries; both legs are billed to us.
    if (!canCall(destination)) {
      throw new HttpError(403, 'destination_not_supported', 'Dimts cannot call numbers in this country or premium-rate numbers.');
    }
    if (!canCall(user.phone)) {
      throw new HttpError(403, 'handset_not_supported', 'Dimts cannot ring your phone number in this country.');
    }

    // Validate callback configuration before reserving or spending anything.
    const callback = new URL(config.publicBaseUrl);
    if (callback.protocol !== 'https:') throw new HttpError(503, 'callbacks_unavailable');
    await reapStaleCalls(user.id);
    const active = await queryOne(`SELECT * FROM calls WHERE user_id=$1 AND request_key<>$2 AND status IN ('initiating','ringing','in-progress') LIMIT 1`, [user.id, requestKey]);
    if (active?.twilio_call_sid) await reconcileCall(active);
    const previous = await queryOne('SELECT id FROM calls WHERE user_id=$1 AND request_key=$2', [user.id, requestKey]);
    if (!previous) await checkCallDestination(user.phone, destination);
    const { call, created } = await reserveCall(user, destination, record, requestKey);
    if (!created) return res.status(200).json({ callId: call.id, status: call.status });

    try {
      const sid = await originateCall({
        callId: call.id,
        userPhone: user.phone,
        destination,
        agentNumber: call.agent_number,
      });
      await query('UPDATE calls SET twilio_call_sid = $2 WHERE id = $1', [
        call.id,
        sid,
      ]);
    } catch (err) {
      captureCallFailure(err, { callId: call.id, userId: user.id, stage: 'originate' });
      // Keep the row so the failure is visible in Recents rather than the
      // call vanishing with only a toast.
      await query(
        `UPDATE calls SET status = 'failed', error = $2, budget_released = $3 WHERE id = $1`,
        [call.id, String(err?.message ?? err).slice(0, 500), [400, 401, 403, 404, 422].includes(err?.status)]
      );
      throw err;
    }

    res.status(201).json({ callId: call.id, status: call.status });
  } catch (err) {
    next(err);
  }
});

callsRouter.post('/:id/end', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne('SELECT * FROM calls WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
    if (!call) throw new HttpError(404, 'call_not_found');
    const result = await reconcileCall(call, { stop: true });
    if (!result.ended) throw new HttpError(409, 'call_stop_pending', 'The call is still starting or stopping. Try End call again shortly.');
    res.json({ status: 'ended' });
  } catch (err) { next(err); }
});

callsRouter.get('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await reapStaleCalls(user.id);
    await scheduleArchiveRetries(user.id).catch(err => console.error('[archive] retry scheduling failed', err?.message));

    const { rows } = await query(
      `SELECT ${LIST_COLUMNS} FROM calls c
         LEFT JOIN contacts k ON k.id = c.contact_id
        WHERE c.user_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC
        LIMIT 100`,
      [user.id]
    );

    res.json({ calls: rows.map(todayCard) });
  } catch (err) {
    next(err);
  }
});

// Pair each flagged difference with the earlier agreement it differs from.
// Earlier calls that were deleted or belong to someone else drop out.
async function resolveConflicts(userId, call) {
  const conflicts = Array.isArray(call.conflicts) ? call.conflicts : [];
  const agreements = Array.isArray(call.agreements) ? call.agreements : [];
  const ids = [...new Set(conflicts.map(item => item?.previous_call_id).filter(id => /^[0-9a-f-]{36}$/i.test(id ?? '')))];
  if (!ids.length) return [];
  const { rows } = await query(`SELECT id, created_at, agreements FROM calls
    WHERE user_id=$1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, [userId, ids]);
  const earlier = new Map(rows.map(row => [row.id, row]));
  return conflicts.flatMap(item => {
    const now = agreements[item.new_index], previous = earlier.get(item.previous_call_id);
    const before = Array.isArray(previous?.agreements) ? previous.agreements[item.previous_index] : null;
    if (!now || !before) return [];
    return [{ note: item.note, now, before: { ...before, call_id: previous.id, created_at: previous.created_at } }];
  });
}

callsRouter.get('/:id', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    await expireRecordingWait(user.id);
    await expireProcessing(user.id);
    const call = await queryOne(
      `SELECT c.id, c.destination, c.status, c.duration_sec, c.direction, c.voicemail,
              c.recording_url, c.transcript, c.transcript_data, c.transcript_recording_url, c.summary, c.next_moves,
              c.action_items, c.key_points, c.followups, c.error, c.created_at,
              c.record_enabled, c.parent_consent_at, c.child_consent_at, c.recording_start_status,
              c.consent_mode, c.consent_scope, c.other_party_notice_issued_at,
              c.deleted_at,c.provider_deletion_status,c.provider_deletion_error,c.provider_deleted_at,
              c.agreements, c.conflicts, c.contact_id, c.audio_object_key,
              k.display_name AS contact_name, k.company
         FROM calls c
         LEFT JOIN contacts k ON k.id = c.contact_id
        WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, user.id]
    );

    if (!call) throw new HttpError(404, 'call_not_found');

    const { transcript_data, transcript_recording_url, consent_scope, audio_object_key, ...detail } = call;
    detail.capture = captureState({ ...call, has_audio: !!(call.recording_url || audio_object_key) });
    detail.conflicts = await resolveConflicts(user.id, call);
    detail.telegram_send = await queryOne(`SELECT request, draft, status, updated_at FROM telegram_sends
      WHERE call_id=$1 AND user_id=$2`, [call.id, user.id]);
    res.set('Cache-Control','private, no-store').json({
      ...detail,
      recording_authorized: hasRecordingAuthorization(call),
      transcript_turns: transcriptTurns(call),
      // The app never gets Twilio's URL directly; it would need Twilio
      // credentials to fetch it.
      audio_url: call.recording_url ? `/api/calls/${call.id}/audio` : null,
    });
  } catch (err) {
    next(err);
  }
});

callsRouter.get('/:id/notes', async (req, res) => {
  const user = await resolveUser(req);
  const call = await queryOne(`SELECT c.id,c.destination,c.direction,c.status,c.duration_sec,
      c.created_at,c.transcript,c.transcript_data,c.transcript_recording_url,c.recording_url,c.summary,c.key_points,c.action_items,c.next_moves,
      k.display_name AS contact_name FROM calls c LEFT JOIN contacts k ON k.id=c.contact_id
    WHERE c.id=$1 AND c.user_id=$2 AND c.deleted_at IS NULL`, [req.params.id, user.id]);
  if (!call) throw new HttpError(404, 'call_not_found');
  res.type('text/plain').set('Cache-Control', 'private, no-store')
    .set('Content-Disposition', `attachment; filename="dimts-call-${call.id}.txt"`).send(callNotes({ ...call, transcript_turns: transcriptTurns(call) }));
});

/** Retry hook for a row stuck in 'processing' — safe to call repeatedly. */
callsRouter.post('/:id/process', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne(
      'SELECT id, recording_url, status, processing_until FROM calls WHERE id = $1 AND user_id = $2',
      [req.params.id, user.id]
    );

    if (!call) throw new HttpError(404, 'call_not_found');
    if (!call.recording_url) throw new HttpError(409, 'no_recording_yet');
    if (!['failed', 'processing'].includes(call.status)) throw new HttpError(409, 'processing_not_retryable');
    if (call.processing_until && new Date(call.processing_until) > new Date()) throw new HttpError(409, 'processing_active');

    defer(processRecording(call.id), `reprocess:${call.id}`);
    res.status(202).json({ status: 'processing' });
  } catch (err) {
    next(err);
  }
});

/**
 * Proxies recording media so the app never holds Twilio credentials.
 * Native audio and authenticated browser fetches send the session bearer.
 */
callsRouter.get('/:id/audio', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const call = await queryOne(
      'SELECT id, recording_url, recording_sid, audio_object_key, voicemail FROM calls WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [req.params.id, user.id]
    );

    if (!call?.recording_url && !call?.audio_object_key) throw new HttpError(404, 'recording_not_found');

    const range = req.get('range');
    if (range && (range.length > 64 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) {
      return res.status(416).end();
    }
    // Archived audio lives in EU storage; older calls still stream from Twilio.
    const upstream = call.audio_object_key
      ? await getAudio(call.audio_object_key, { range })
      : await fetchRecording(call.recording_url, { range, channels: recordingChannels(call), recordingSid: call.recording_sid });
    const recent = await queryOne(`SELECT 1 AS seen FROM audit_events WHERE user_id=$1 AND action='audio_played'
      AND target_id=$2 AND created_at > now()-interval '1 hour' LIMIT 1`, [user.id, call.id]);
    if (!recent) await audit({ userId: user.id, action: 'audio_played', targetType: 'call', targetId: call.id, req });
    if (upstream.status === 416) {
      const contentRange = upstream.headers.get('content-range');
      if (/^bytes \*\/\d+$/.test(contentRange ?? '')) res.set('Content-Range', contentRange);
      res.set('Cache-Control', 'private, no-store');
      return res.status(416).end();
    }
    if (!upstream.ok || !upstream.body) {
      throw new HttpError(502, 'recording_fetch_failed');
    }

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, no-store');
    if (upstream.status === 206) {
      const contentRange = upstream.headers.get('content-range');
      if (!/^bytes \d+-\d+\/\d+$/.test(contentRange ?? '')) throw new HttpError(502, 'invalid_audio_range');
      res.status(206).set('Content-Range', contentRange);
    }
    if (upstream.headers.get('accept-ranges') === 'bytes') res.set('Accept-Ranges', 'bytes');
    const length = upstream.headers.get('content-length');
    if (length) res.set('Content-Length', length);

    const { Readable } = await import('node:stream');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (res.headersSent) res.destroy();
    else next(err);
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

