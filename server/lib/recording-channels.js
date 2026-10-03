/** Bridged calls record two channels; a voicemail is one. */
export const recordingChannels = call => (call?.voicemail ? 1 : 2);
