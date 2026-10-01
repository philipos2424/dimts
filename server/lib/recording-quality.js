// Signal presence does not prove speech, identity, clarity or complete capture.
// Guard both fresh responses and saved checkpoints before generating actions.
export function recordingQualityError(raw) {
  const quality = raw?.audio_quality;
  if (quality?.status === 'silent') return 'The recording contains no detectable audio signal. Play or export the saved audio to check it. AI notes were not generated.';
  if (quality?.status === 'single_channel') return 'This recording has only one audio channel, so both sides cannot be confirmed separately. Play or export the saved audio. AI notes were not generated.';
  if (quality?.status === 'missing_channel_signal') return 'Only one recording channel contains detectable audio. A participant may have been quiet or their audio may be missing. Play or export the saved audio; AI notes were not generated.';
  if (Array.isArray(raw?.transcripts) && raw.transcripts.length > 0) {
    if (raw.transcripts.length !== 2 || raw.transcripts.some(channel => !channel?.text?.trim())) {
      return 'Speech could not be transcribed from both recording channels. A participant may have been quiet or transcription may be incomplete. Available audio and text are saved; AI notes were not generated.';
    }
  }
  return null;
}
