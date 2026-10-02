# Synthetic provider check

`ai-smoke.wav` is a 23.5-second, stereo, 16-bit PCM conversation generated
with Windows System.Speech. It contains no customer recording or credentials.
Channel 0 is the account owner; channel 1 is the other participant.

Owner: Hello. Who am I speaking with?

Caller: Hello. My name is Alex from Demo Company. Can we meet Friday October
ninth at two P M U T C? I will email you the proposal.

Owner: Yes Alex. I agree to meet Friday October ninth at two P M U T C. Thank you.

The optional `AI_SMOKE_ON_BUILD=1` check uses the configured transcription and
LLM providers, including their billing. It fails the build if transcription,
speaker attribution, summary or caller identification fails. Leave the flag
unset or set to `0` for normal builds. Output contains only check results and
sanitized errors; no provider bodies or credentials.

This check does not prove Twilio call routing, recording callbacks, phone OTP,
Google OAuth or behavior on physical Android/iPhone devices.
