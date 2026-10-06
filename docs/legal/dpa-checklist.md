# Data-processing agreement checklist (founder actions)

> These steps happen outside the code. Tick each one before the EU launch.
> Confirm each provider's current process on its website, because the steps
> can change.

- [ ] **Supabase.** Sign the DPA in the dashboard (Organization → Legal
  Documents). Keep the project in `eu-west-1` (Ireland), where production runs. Turn on two-factor login.
- [ ] **Vercel.** Accept the DPA (Team Settings → Legal). Confirm
  `regions: ["fra1"]` is live on the latest deployment. Turn on two-factor login.
- [ ] **Twilio.**
  - Accept the Data Protection Addendum (Console → Legal).
  - Turn on two-factor login.
  - After the backfill script runs, confirm that no recordings remain under
    Voice → Recordings.
- [ ] **ElevenLabs.**
  - Accept the DPA.
  - Ask whether your plan offers zero-retention mode and EU data residency.
    If it does, set `ELEVENLABS_ZERO_RETENTION=true` and
    `ELEVENLABS_BASE_URL=https://api.eu.residency.elevenlabs.io` in Vercel.
  - Confirm that API audio is not used for training.
- [ ] **OpenAI.**
  - Accept the DPA (organization settings).
  - API data is not used for training by default.
  - Ask about zero data retention for the project.
  - For EU residency, create an EU project and set
    `OPENAI_BASE_URL=https://eu.api.openai.com/v1` in Vercel.
- [ ] **One LLM provider.** Production must run `LLM_PROVIDER=openai`. Ollama
  Cloud is not a listed subprocessor; do not configure it in production.
- [ ] **Expo.** Accept the DPA for push notifications.
- [ ] **Polar.** Accept the merchant-of-record terms and DPA before release 3.
- [ ] **GitHub, Google Cloud.** Turn on two-factor login.
- [ ] **Rotate** any API key that has ever been pasted into a chat, a log or
  a screenshot.
- [ ] **Records of processing.** Keep this checklist, `subprocessors.md` and
  the privacy policy together as your Article 30 record.
- [ ] **Ethiopia.** Ask local counsel about the Personal Data Protection
  Proclamation (2024): consent wording, and whether storing Ethiopians'
  call data in the EU and processing it in the US needs authorization.
- [ ] **Germany and Austria.** Ask counsel to confirm press-1 consent is
  enough, and whether other EU states need it.
- [ ] **Lawyer review** of `privacy-policy.md` and `terms.md` before the EU launch.
