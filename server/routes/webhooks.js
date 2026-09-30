import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { defer } from '../lib/defer.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';
import { currentMonth } from '../lib/users.js';
import { processRecording } from '../services/process-recording.js';
import { askRecordingConsent, dialCall } from '../lib/recording-consent.js';

const { VoiceResponse } = twilio.twiml;

/**
 * Two routers rather than one mounted at '/', because a router-level guard
 * mounted at the root also runs for paths the router does not handle - which
 * made every unmatched URL answer 403 instead of 404.
 */
export const twimlRouter = express.Router();
export const webhooksRouter = express.Router();

twimlRouter.use(verifyTwilioSignature);
webhooksRouter.use(verifyTwilioSignature);

/**
 * Find the call a webhook refers to.
 *
 * Every callback URL carries ?callId= because the recording callback reports
 * the *parent* leg's CallSid, which makes SID matching alone fragile. The SID
 * lookup stays as a fallback for callbacks we did not construct.
 */
async function resolveCall({ callId, callSid }) {
  if (callId) {
    const byId = await queryOne('SELECT * FROM calls WHERE id = $1', [callId]);
    if (byId) {
      if (!callSid || (byId.twilio_call_sid && byId.twilio_call_sid !== callSid)) return undefined;
      return byId;
    }
  }
  if (callSid) {
    return queryOne('SELECT * FROM calls WHERE twilio_call_sid = $1', [callSid]);
  }
  return undefined;
}

/** TwiML fetched when the user answers leg A: dial the destination, record both. */
twimlRouter.post('/bridge', async (req, res) => {
  const callId = req.query.callId ?? req.body?.callId;
  const call = await resolveCall({ callId, callSid: req.body?.CallSid });
  const destination = call?.direction === 'outbound' ? call.destination : null;
  const base = config.publicBaseUrl;

  const twiml = new VoiceResponse();

  if (!destination) {
    twiml.say('Sorry, no destination was provided for this call.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (call.record_enabled !== false) askRecordingConsent(twiml, `${base}/twiml/accept?callId=${call.id}`);
  else dialCall(twiml, call);

  res.type('text/xml').send(twiml.toString());
});

twimlRouter.post('/accept', async (req, res) => {
  const call = await resolveCall({ callId: req.query.callId, callSid: req.body?.CallSid });
  const twiml = new VoiceResponse();
  if (call && req.body?.Digits === '1') {
    await query('UPDATE calls SET parent_consent_at = now() WHERE id = $1', [call.id]);
    dialCall(twiml, call);
  } else twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// Runs on the dialled party's leg before Twilio bridges the two people.
twimlRouter.post('/party-consent', async (req, res) => {
  const call = await queryOne('SELECT * FROM calls WHERE id = $1', [req.query.callId]);
  const twiml = new VoiceResponse();
  if (!call?.parent_consent_at || !req.body?.CallSid ||
      (call.child_call_sid && call.child_call_sid !== req.body.CallSid)) twiml.hangup();
  else if (req.body.Digits === '1') {
    await query(`UPDATE calls SET child_consent_at = now(), child_call_sid = $2
      WHERE id = $1 AND (child_call_sid IS NULL OR child_call_sid = $2)`, [call.id, req.body.CallSid]);
  } else if (req.body.Digits) twiml.hangup();
  else {
    await query(`UPDATE calls SET child_call_sid = $2
      WHERE id = $1 AND child_call_sid IS NULL`, [call.id, req.body.CallSid]);
    askRecordingConsent(twiml, `${config.publicBaseUrl}/twiml/party-consent?callId=${call.id}`);
  }
  res.type('text/xml').send(twiml.toString());
});

/** Leg A lifecycle. Drives the status badge in Recents. */
webhooksRouter.post('/call-status', async (req, res) => {
  const { CallStatus, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call) {
    const mapped = { ringing: 'ringing', 'in-progress': 'in-progress' }[CallStatus];

    if (mapped) {
      await query(`UPDATE calls SET status = $2 WHERE id = $1
        AND status IN ('initiating', 'ringing')`, [call.id, mapped]);
    } else if (
      ['busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus) &&
      // A completed dial has already moved the row on; don't drag it back.
      ['initiating', 'ringing'].includes(call.status)
    ) {
      await query(
        `UPDATE calls SET status = 'failed', error = $2 WHERE id = $1`,
        [call.id, `Call ${CallStatus}`]
      );
    }
  }

  res.status(204).end();
});

/**
 * Leg B finished. The single source of truth for duration and billing —
 * RecordingDuration arrives separately and must not also increment minutes,
 * or every call is counted twice.
 */
twimlRouter.post('/dial-done', async (req, res) => {
  const { DialCallStatus, DialCallDuration, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call) {
    const seconds = Number(DialCallDuration ?? 0) || 0;
    const connected = DialCallStatus === 'completed' && seconds > 0;

    // On an inbound call the dialled leg is the user's own handset, so an
    // unanswered dial means a missed call rather than a failed one.
    const missedStatus = call.direction === 'inbound' ? 'missed' : 'failed';

    // duration_sec IS NULL guards against a webhook retry double-billing.
    const updated = await queryOne(
      `UPDATE calls
          SET duration_sec = $2,
              status = CASE WHEN status = 'ready' THEN status
                            WHEN $3 AND record_enabled THEN 'processing'
                            WHEN $3 THEN 'completed' ELSE $5 END,
              error = CASE WHEN $3 THEN error ELSE $4 END
        WHERE id = $1 AND duration_sec IS NULL
        RETURNING id, user_id`,
      [call.id, seconds, connected, `Dial ${DialCallStatus}`, missedStatus]
    );

    if (updated && connected) {
      await query(
        `INSERT INTO usage_minutes (user_id, month, minutes_used)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, month)
         DO UPDATE SET minutes_used = usage_minutes.minutes_used + EXCLUDED.minutes_used`,
        [updated.user_id, currentMonth(), seconds / 60]
      );
    }
  }

  const twiml = new VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

/**
 * Recording is ready. ACK immediately — Twilio gives up after ~15s and the
 * transcribe + summarize pipeline takes far longer than that.
 */
webhooksRouter.post('/recording-ready', async (req, res) => {
  const { RecordingUrl, RecordingStatus, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call && call.record_enabled !== false && call.parent_consent_at && call.child_consent_at && RecordingStatus === 'completed' && RecordingUrl) {
    const accepted = await queryOne(
      `UPDATE calls SET recording_url = $2, status = 'processing'
       WHERE id = $1 AND recording_url IS NULL AND status <> 'ready'
       RETURNING id`,
      [call.id, RecordingUrl]
    );
    if (accepted) defer(processRecording(call.id), `process:${call.id}`);
  }

  res.status(204).end();
});
