# Data-processing agreement checklist (founder actions)

> These steps happen outside the code. Tick each one before the EU launch.
> Confirm each provider's current process on its website, because the steps
> can change.

- [ ] **Supabase.** Sign the DPA in the dashboard (Organization → Legal
  Documents). Keep the project in `eu-central-2`. Turn on two-factor login.
- [ ] **Vercel.** Accept the DPA (Team Settings → Legal). Confirm
  `regions: ["fra1"]` is live on the latest deployment. Turn on two-factor login.
- [ ] **Twilio.**
  - Accept the Data Protection Addendum (Console → Legal).
  - Turn on two-factor login.
  - After the backfill script runs, confirm that no recordings remain under
    Voice → Recordings.
- [ ] **ElevenLabs.**
  - Accept the DPA.
  - Ask whether your plan offers zero-retention mode, and enable it if it does.
  - Confirm that API audio is not used for training.
- [ ] **OpenAI.**
  - Accept the DPA (organization settings).
  - API data is not used for training by default.
  - Ask about zero data retention for the project.
- [ ] **Ollama Cloud** (if used instead of OpenAI): confirm its data
  retention and training terms. If they are not acceptable, switch to a
  provider with a DPA.
- [ ] **Expo.** Accept the DPA for push notifications.
- [ ] **Polar.** Accept the merchant-of-record terms and DPA before release 3.
- [ ] **GitHub, Google Cloud.** Turn on two-factor login.
- [ ] **Rotate** any API key that has ever been pasted into a chat, a log or
  a screenshot.
- [ ] **Records of processing.** Keep this checklist, `subprocessors.md` and
  the privacy policy together as your Article 30 record.
- [ ] **Lawyer review** of `privacy-policy.md` and `terms.md` before the EU launch.
