# Dimts Subprocessors

> **DRAFT.** Shown in the app at `/subprocessors` (from `SUBPROCESSORS` in
> `src/legal.ts`; keep the two in sync). Notify customers of any changes.

| Provider | Purpose | Data | Location | Transfer basis |
|---|---|---|---|---|
| Supabase | Database and call-audio storage | Account data, notes, transcripts, audio | EU (Ireland, `eu-west-1`) | Inside the EU |
| Vercel | Application hosting | Data in transit through the API | EU (Frankfurt, `fra1`) | Inside the EU |
| Telnyx | Phone numbers, call connection, temporary recording before archiving, sign-in codes | Phone numbers, call audio (deleted after archiving) | United States | SCCs, Telnyx DPA |
| Twilio | Previous carrier; no new calls, being removed | Recordings of older calls until archived or deleted | United States | SCCs, Twilio DPA |
| ElevenLabs | Speech-to-text | Call audio | United States (EU with `ELEVENLABS_BASE_URL`, Enterprise) | SCCs, ElevenLabs DPA |
| Ollama (Ollama Cloud, open model) | Summaries, names, next steps, answers | Transcript text, not logged, retained or trained on | United States; overflow to Europe or Singapore | SCCs, provider terms |
| Expo | Push notifications | Device push token, notification text with no call content | United States | SCCs, Expo DPA |
| Google | Calendar events and Gmail drafts, **only if the user connects them** | Approved event and draft content | Per the user's Google account | The user's own Google terms |
| Polar | Payments as merchant of record: checkout, VAT and sales tax, receipts, plan management | Your Dimts account ID, name, email, billing address, payment method (cards are handled by Stripe for Polar; Dimts never sees card numbers) | United States | SCCs, Polar DPA |
