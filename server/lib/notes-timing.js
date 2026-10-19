/**
 * How long the owner waited for notes, as whole seconds for the notes_ready
 * event: from hang-up, in the queue before processing, and in each stage.
 * Timings only; nothing about the call's content. A stage that did not run
 * (a reused transcript) or a time we do not know is left out, not zero.
 */
export function notesReadyTimings({ completedAt, startedAtMs, transcribeMs, summaryMs, nowMs = Date.now() }) {
  const secs = ms => Math.max(0, Math.round(ms / 1000));
  const hangupMs = completedAt ? new Date(completedAt).getTime() : NaN;
  const out = {};
  if (Number.isFinite(hangupMs)) {
    out.seconds_after_hangup = secs(nowMs - hangupMs);
    out.queue_seconds = secs(startedAtMs - hangupMs);
  }
  out.processing_seconds = secs(nowMs - startedAtMs);
  if (Number.isFinite(transcribeMs)) out.transcribe_seconds = secs(transcribeMs);
  if (Number.isFinite(summaryMs)) out.summary_seconds = secs(summaryMs);
  return out;
}
