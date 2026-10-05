import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { defer } from '../lib/defer.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';
import { currentMonth } from '../lib/users.js';
import { finishCall } from '../db/finish-call.js';
import { processRecording } from '../services/process-recording.js';
import { askRecordingConsent, dialCall, issueRecordingNotice, offerVoicemail, recordsThroughDial, RECORDING_NOTICE } from '../lib/recording-consent.js';
import { hasRecordingAuthorization, recordingAuthorizationSql } from '../lib/recording-policy.js';
import { beginAgreedRecording } from '../db/start-recording.js';
import { processDeletion } from '../services/process-deletion.js';
import { reconcileCall } from '../services/end-call.js';
import { isCallSid, isRecordingSid } from '../lib/carrier.js';

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

/**
 * Telnyx may not return the call SID when a call is created; the first webhook
 * for a call we started (it carries our ?callId=) supplies it instead.
 */
async function adoptCallSid(callId, callSid) {
  if (!callId || !isCallSid(callSid)) return;
  await query(`UPDATE calls SET twilio_call_sid=$2 WHERE id=$1 AND twilio_call_sid IS NULL AND direction='outbound'`, [callId, callSid]);
}

/** TwiML fetched when the user answers leg A: dial the destination, record both. */
twimlRouter.post('/bridge', async (req, res) => {
  const callId = req.query.callId ?? req.body?.callId;
  await adoptCallSid(callId, req.body?.CallSid);
  const call = await resolveCall({ callId, callSid: req.body?.CallSid });
  const destination = call?.direction === 'outbound' ? call.destination : null;
  const base = config.publicBaseUrl;

  const twiml = new VoiceResponse();

  if (!destination) {
    twiml.say('Sorry, no destination was provided for this call.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Notice calls need no key press from the owner: their consent is on the account.
  if (call.record_enabled !== false && call.consent_mode !== 'notice') askRecordingConsent(twiml, `${base}/twiml/accept?callId=${call.id}`, call.consent_mode === 'owner_only');
  else dialCall(twiml, call);

  res.type('text/xml').send(twiml.toString());
});

twimlRouter.post('/accept', async (req, res) => {
  const call = await resolveCall({ callId: req.query.callId, callSid: req.body?.CallSid });
  const twiml = new VoiceResponse();
  if (!call || call.duration_sec != null || (call.consent_mode === 'owner_only' && call.direction !== 'outbound')) twiml.hangup();
  else {
    const accepted = req.body?.Digits === '1' && call.record_enabled !== false;
    const chosen = await queryOne(`UPDATE calls SET parent_consent_choice=$2,
      parent_consent_at=CASE WHEN $2='accepted' THEN now() ELSE NULL END,
      record_enabled=record_enabled AND $2='accepted',twilio_call_sid=COALESCE(twilio_call_sid,$3)
      WHERE id=$1 AND parent_consent_choice IS NULL RETURNING *`, [call.id, accepted ? 'accepted' : 'declined', req.body.CallSid]);
    const current = chosen ?? await queryOne('SELECT * FROM calls WHERE id = $1', [call.id]);
    if (current?.record_enabled === false) twiml.say('Connecting without recording.');
    if (current) dialCall(twiml, current); else twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

// Runs on the dialled party's leg before Twilio bridges the two people.
twimlRouter.post('/party-consent', async (req, res) => {
  const twiml = new VoiceResponse();
  if (!req.body?.CallSid) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }
  const call = await queryOne(`UPDATE calls SET child_call_sid=$2 WHERE id=$1 AND duration_sec IS NULL
    AND (child_call_sid IS NULL OR child_call_sid=$2) RETURNING *`, [req.query.callId, req.body.CallSid]);
  if (!call) twiml.hangup();
  else if (call.record_enabled === false) twiml.say('This call is not being recorded. Connecting.');
  else if (call.consent_mode === 'notice' && call.direction === 'outbound') {
    if (!call.parent_consent_at) twiml.hangup();
    else {
      await queryOne(`UPDATE calls SET other_party_notice_issued_at=COALESCE(other_party_notice_issued_at,now())
        WHERE id=$1 AND child_call_sid=$2 AND duration_sec IS NULL RETURNING id`, [call.id, req.body.CallSid]);
      if (call.recording_start_status) return res.type('text/xml').send(twiml.toString());
      if (recordsThroughDial(call)) {
        // Only <Gather>/<Hangup> are allowed here on Telnyx; <Dial> records once bridged.
        twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 1 }).say(RECORDING_NOTICE);
        return res.type('text/xml').send(twiml.toString());
      }
      issueRecordingNotice(twiml);
      // Same empty-Gather technique as owner-only: wait out the notice, then record.
      twiml.gather({ input:'dtmf',numDigits:1,timeout:1,method:'POST',actionOnEmptyResult:true,
        action:`${config.publicBaseUrl}/twiml/record-after-notice?callId=${call.id}` });
    }
  }
  else if (call.consent_mode === 'notice' && call.direction === 'inbound') {
    // The caller heard the notice before the owner's phone rang.
    if (!call.other_party_notice_issued_at || !call.child_consent_at) twiml.hangup();
    else if (!recordsThroughDial(call)) await beginAgreedRecording(call.id, req.body.CallSid);
  }
  else if (call.consent_mode === 'owner_only' && !call.consent_scope?.trim()) twiml.hangup();
  else if (call.consent_mode === 'owner_only' && call.direction === 'outbound') {
    if (!call.parent_consent_at) twiml.hangup();
    else {
      await queryOne(`UPDATE calls SET other_party_notice_issued_at=COALESCE(other_party_notice_issued_at,now())
        WHERE id=$1 AND child_call_sid=$2 AND duration_sec IS NULL RETURNING id`, [call.id, req.body.CallSid]);
      issueRecordingNotice(twiml);
      // <Number url> supports Say/Gather but not Redirect. An empty Gather
      // waits after Say, then posts on timeout; it asks for no acceptance and
      // never stores the other person's digits as consent.
      twiml.gather({ input:'dtmf',numDigits:1,timeout:1,method:'POST',actionOnEmptyResult:true,
        action:`${config.publicBaseUrl}/twiml/record-after-notice?callId=${call.id}` });
    }
  }
  else if (call.consent_mode === 'owner_only' ? !call.other_party_notice_issued_at : !call.parent_consent_at) twiml.hangup();
  else if (req.query.choice === '1') {
    const choice = req.body.Digits === '1' ? 'accepted' : 'declined';
    const chosen = await queryOne(`UPDATE calls SET child_consent_choice=$3,
      child_consent_at=CASE WHEN $3='accepted' THEN now() ELSE NULL END,
      record_enabled=record_enabled AND $3='accepted'
      WHERE id=$1 AND child_call_sid=$2 AND child_consent_choice IS NULL RETURNING *`, [call.id, req.body.CallSid, choice]);
    const current = chosen ?? await queryOne('SELECT * FROM calls WHERE id = $1', [call.id]);
    if (current.record_enabled === false) twiml.say('Connecting without recording.');
    else {
      const recording = await beginAgreedRecording(call.id, req.body.CallSid);
      twiml.say(recording.record_enabled === false ? 'Recording is unavailable. Connecting without recording.' : 'Recording agreed. Connecting.');
    }
  } else if (call.child_consent_choice) {
    await beginAgreedRecording(call.id, req.body.CallSid);
  } else {
    askRecordingConsent(twiml, `${config.publicBaseUrl}/twiml/party-consent?callId=${call.id}&choice=1`, call.consent_mode === 'owner_only');
  }
  res.type('text/xml').send(twiml.toString());
});

twimlRouter.post('/record-after-notice', async (req, res) => {
  const call = await queryOne('SELECT * FROM calls WHERE id=$1', [req.query.callId]);
  const twiml = new VoiceResponse();
  if (!call || !['owner_only','notice'].includes(call.consent_mode) || call.direction !== 'outbound' ||
      !req.body?.CallSid || call.child_call_sid !== req.body.CallSid || call.duration_sec != null || !hasRecordingAuthorization(call)) twiml.hangup();
  else {
    const recording = await beginAgreedRecording(call.id, req.body.CallSid);
    if (recording.record_enabled === false) twiml.say('Recording is unavailable. Connecting without recording.');
  }
  res.type('text/xml').send(twiml.toString());
});

/** Leg A lifecycle. Drives the status badge in Recents. */
webhooksRouter.post('/call-status', async (req, res) => {
  const { CallStatus, CallSid } = req.body ?? {};
  await adoptCallSid(req.query.callId, CallSid);
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call) {
    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus) && call.duration_sec == null) {
      const result = await reconcileCall(call);
      if (result.ended) return res.status(204).end();
    }
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

  // The network refused the call carrying the owner's own number (Ethio Telecom
  // blocks local caller IDs arriving from abroad). The owner is still on the
  // line, so ring the same person once more from the Dimts number. Busy and
  // no-answer are the other person's choice and are not retried.
  const retry = call?.direction === 'outbound' && DialCallStatus === 'failed' && call.caller_id &&
    await queryOne(`UPDATE calls SET caller_id=NULL, child_call_sid=NULL
      WHERE id=$1 AND caller_id IS NOT NULL AND duration_sec IS NULL RETURNING *`, [call.id]);
  if (retry) {
    const twiml = new VoiceResponse();
    twiml.say('Your number could not be shown. Calling from your Dimts number.');
    dialCall(twiml, retry);
    return res.type('text/xml').send(twiml.toString());
  }

  if (call) {
    await finishCall(call, Number(DialCallDuration ?? 0), DialCallStatus, currentMonth());
  }

  const twiml = new VoiceResponse();
  // The owner did not pick up and the caller is still on the line. Only callers
  // whose recording is already authorized (they heard the notice) are offered it.
  const voicemail = call && call.direction === 'inbound' && ['no-answer', 'busy', 'failed'].includes(DialCallStatus) &&
    hasRecordingAuthorization(call) && await queryOne(`UPDATE calls SET voicemail=true
      WHERE id=$1 AND deleted_at IS NULL AND recording_url IS NULL AND NOT voicemail AND ${recordingAuthorizationSql}
      RETURNING id`, [call.id]);
  if (voicemail) offerVoicemail(twiml, call);
  else twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

twimlRouter.post('/voicemail-done', (_req, res) => {
  const twiml = new VoiceResponse();
  twiml.say('Thank you. Goodbye.');
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

  if (call?.deleted_at && RecordingStatus === 'completed' && isRecordingSid(req.body.RecordingSid)) {
    const pending = await queryOne(`UPDATE calls SET recording_sid=COALESCE(recording_sid,$2),
        provider_deletion_status='pending',provider_deleted_at=NULL,provider_deletion_error=NULL,
        provider_deletion_token=CASE WHEN recording_sid IS NULL THEN NULL ELSE provider_deletion_token END,
        provider_deletion_until=CASE WHEN recording_sid IS NULL THEN NULL ELSE provider_deletion_until END,
        provider_deletion_attempted_at=CASE WHEN recording_sid IS NULL THEN NULL ELSE provider_deletion_attempted_at END
      WHERE id=$1 AND deleted_at IS NOT NULL AND (recording_sid IS NULL OR recording_sid=$2)
        AND (provider_deletion_status<>'confirmed' OR recording_sid IS NULL) RETURNING id`,
      [call.id, req.body.RecordingSid]);
    if (pending) defer(processDeletion(call.id), `late-delete:${call.id}`);
    return res.status(204).end();
  }

  if (call && hasRecordingAuthorization(call) && RecordingStatus === 'completed' && RecordingUrl) {
    if (call.recording_start_status && (!isRecordingSid(req.body.RecordingSid) ||
      (call.recording_sid && call.recording_sid !== req.body.RecordingSid))) return res.status(204).end();
    // Telnyx skips the <Dial> action when the owner hangs up first, so no
    // dial-done receipt arrives. The recording covers the connected
    // conversation; use its length so minutes and history stay right.
    const recorded = /^\d{1,5}$/.test(req.body.RecordingDuration ?? '') ? Number(req.body.RecordingDuration) : null;
    if (call.duration_sec == null && !call.voicemail && recorded != null) {
      await finishCall(call, recorded, 'completed', currentMonth());
    }
    const accepted = await queryOne(
      `UPDATE calls SET recording_url = $2, status = 'processing', error=NULL,processing_requested_at=now(),
        recording_sid=COALESCE(recording_sid,$3),recording_start_status='started',
        duration_sec=CASE WHEN voicemail THEN COALESCE($4::int, duration_sec) ELSE duration_sec END
       WHERE id = $1 AND recording_url IS NULL AND status <> 'ready'
         AND ${recordingAuthorizationSql}
         AND (recording_sid IS NULL OR recording_sid=$3)
       RETURNING id`,
      [call.id, RecordingUrl, req.body.RecordingSid ?? null,
        /^\d{1,5}$/.test(req.body.RecordingDuration ?? '') ? Number(req.body.RecordingDuration) : null]
    );
    if (accepted) defer(processRecording(call.id), `process:${call.id}`);
  }

  res.status(204).end();
});
