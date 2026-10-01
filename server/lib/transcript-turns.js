// Expose only sanitized timing/text, never a raw provider response. Timing must
// belong to this recording and reproduce the transcript the user is reviewing.
export function transcriptTurns(call) {
  if (call.deleted_at || !call.recording_url || call.transcript_recording_url !== call.recording_url || !call.transcript) return [];
  const transcripts = call.transcript_data?.transcripts;
  if (!Array.isArray(transcripts) || transcripts.length !== 2) return [];
  const labels = call.direction === 'inbound' ? ['Caller', 'User'] : ['User', 'Caller'];
  const tokens = [];
  for (const [channel, transcript] of transcripts.entries()) {
    if (!Array.isArray(transcript?.words)) return [];
    const words = transcript.words.filter(word => word && (!word.type || word.type === 'word'));
    if (!words.length && typeof transcript.text === 'string' && transcript.text.trim()) return [];
    for (const word of words) {
      if (typeof word.text !== 'string' || !word.text.trim() || !Number.isFinite(word.start) || word.start < 0 ||
          (word.end != null && (!Number.isFinite(word.end) || word.end < word.start)) ||
          (Number.isFinite(call.duration_sec) && call.duration_sec > 0 && word.start >= call.duration_sec)) return [];
      tokens.push({ speaker: labels[channel], start: word.start, end: word.end ?? null, text: word.text });
      if (tokens.length > 100_000) return [];
    }
  }
  const turns = [];
  for (const token of tokens.sort((a,b) => a.start-b.start)) {
    const last = turns.at(-1);
    if (last?.speaker === token.speaker) {
      last.text += ` ${token.text}`;
      last.end = last.end != null && token.end != null ? Math.max(last.end,token.end) : null;
    } else turns.push({ ...token });
  }
  for (const turn of turns) turn.text = turn.text.trim().replace(/\s+/g,' ');
  const reconstructed = turns.map(turn => `${turn.speaker}: ${turn.text}`).join('\n');
  return reconstructed === call.transcript ? turns : [];
}
