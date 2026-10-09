// Must equal TERMS_VERSION in server/lib/terms.js. Bumping it asks every user
// to accept again. The documents mirror docs/legal/*.md.
export const TERMS_VERSION = '2026-10-07';

export const RECORDING_NOTICE = 'This call is recorded and summarized by Dimts AI.';

/**
 * Every third party that receives call content, named before the first call
 * (App Store guideline 5.1.2(i)). Keep in step with SUBPROCESSORS below and
 * DISCLOSED in server/lib/disclosed-providers.js (production refuses other providers) and
 * docs/legal/subprocessors.md.
 */
export const AI_PROVIDERS = [
  { name: 'ElevenLabs', gets: 'call audio', does: 'turns speech into text' },
  { name: 'OpenAI', gets: 'call transcripts', does: 'writes your notes, answers and drafts' },
];

export const EMERGENCY_NOTICE = 'Dimts is not for emergency calls. It cannot reach 911, 112, 999 or other emergency numbers. Use your phone’s own dialler.';

export type LegalSection = { heading: string; body: string };

export const DRAFT_NOTE = 'Draft for legal review. Effective once published at dimts.app.';

export const PRIVACY_POLICY: LegalSection[] = [
  { heading: 'Who we are', body: 'Dimts is an AI assistant for business phone calls. For your account data, Dimts is the controller. For the people you speak with, you are the controller: you decide to record them and need a lawful basis to do so, usually your legitimate interest in an accurate record of business calls, or their consent where the law requires it. Dimts processes their data only on your instructions.' },
  { heading: 'What we collect', body: 'Your phone number and account settings; the calls you make or receive through your Dimts number, including recordings, transcripts and AI notes; the contacts Dimts creates from those calls; and, only if you connect them, limited Google Calendar and Gmail access to create drafts and events you approve.' },
  { heading: 'Why we use it', body: 'To record calls with a notice to the other person, transcribe and summarize them, suggest next steps for you to approve, and keep your account secure. We do not sell your data or use it for advertising. We do not train AI models on your calls, and we do not identify people by their voice. Questions you ask about your calls are answered and then discarded; we do not store them. Our transcription and AI providers process call audio and transcripts only to return a result to us and may not use them to train their models. Unless a zero-retention agreement is in place, they may keep them for a limited period (typically up to 30 days) to detect abuse, then delete them.' },
  { heading: 'Recording notice', body: `Every recorded call begins with: “${RECORDING_NOTICE}” The other person can end the call if they do not want to be recorded.` },
  { heading: 'Where your data lives', body: 'Account data, notes and call audio are stored in the European Union. Calls are connected by Telnyx and transcribed and summarized by our AI providers, some of which process data in the United States under Standard Contractual Clauses. If you live outside the EU, your data is transferred to the EU and the United States to provide the service. The current list of providers is on the Subprocessors page.' },
  { heading: 'How long we keep it', body: 'For 12 months, unless you choose another period in Settings (3, 6 or 24 months, or until you delete them), after which calls are deleted automatically. You can delete a call, a contact or your whole account at any time in Settings. Deleted recordings are removed from our storage and from our call provider. Encrypted database backups expire on their own schedule; deleted content in them cannot be read without keys held outside the database.' },
  { heading: 'Your rights', body: 'You can download all of your data, correct it, or delete it from Settings. People you have called can ask for their data to be deleted at dimts.app/privacy-request. You can also contact privacy@dimts.app or your local data protection authority.' },
  { heading: 'Security', body: 'Data is encrypted in transit. Recordings, transcripts, summaries, drafts and contact notes are encrypted before they are stored, with a key unique to your account; the master keys are kept outside the database, so a copy of the database or its backups alone reveals no conversation. Short structured notes (agreements, next steps) rely on the storage provider’s disk encryption. You can lock the app with Face ID, fingerprint or passcode, see every signed-in device, get warned about new sign-ins and sign out everywhere. Access is limited by account, rate-limited and recorded in an activity log you can view in Settings.' },
];

export const TERMS: LegalSection[] = [
  { heading: 'Using Dimts', body: 'You must be at least 18 and use Dimts for lawful business purposes.' },
  { heading: 'Emergency calls', body: EMERGENCY_NOTICE },
  { heading: 'Recording', body: `You agree that calls through Dimts are recorded and that the other person hears: “${RECORDING_NOTICE}” You are responsible for using recordings lawfully, including where you live and where the people you call live.` },
  { heading: 'AI notes', body: 'Summaries, names and suggested next steps are generated by AI and can be wrong. Check them before you rely on them. Dimts never sends an email or books a meeting without your approval.' },
  { heading: 'Data processing', body: 'For the people you speak with, you are the controller and Dimts is your processor. Dimts processes their data only to provide the service on your instructions; keeps it confidential and secure; uses only the providers on the Subprocessors page and tells you before adding one; helps you answer requests from the people you called; tells you without undue delay about a breach affecting your data; and deletes it when you delete it or close your account. These terms are the data-processing agreement between you and Dimts.' },
  { heading: 'Your content', body: 'Your recordings and notes belong to you. You give Dimts permission to process them only to provide the service to you.' },
  { heading: 'Fair use', body: 'Do not use Dimts for harassment, unlawful surveillance, spam or fraud. We may suspend accounts that do.' },
  { heading: 'Changes and ending', body: 'You can stop using Dimts and delete your account at any time. If these terms change, we will ask you to accept the new version in the app.' },
  { heading: 'Liability', body: 'Dimts is provided as is, to the extent the law allows. Nothing here limits rights you have under consumer protection law.' },
  { heading: "Plans and payment", body: "Paid plans renew automatically every month or year until you cancel. Before you pay, the app shows the price, the renewal interval, the minutes included and how to cancel. Payments are processed by Polar (polar.sh), our merchant of record, which charges any VAT or sales tax and issues your receipts." },
  { heading: "Minutes and credits", body: "Plan minutes reset on the first of each month (UTC) and do not roll over. Calls to or from some countries, and calls after your plan minutes run out, use prepaid credits at the rate shown in the app before the call connects. Credits never expire. If your minutes and credits run out, new calls are not connected until you add more." },
  { heading: "Cancelling and refunds", body: "Cancel any time in the app under Plan. Your plan stays active until the end of the period you paid for and then returns to Free. If you are a consumer in the EU or UK, you can withdraw within 14 days of buying and get a refund, minus the value of minutes and credits you have already used. Unused credits are refunded on request when you delete your account. Nothing here limits your rights under consumer law." },
];

export const SUBPROCESSORS: LegalSection[] = [
  { heading: 'Supabase · EU (Ireland)', body: 'Database and call-audio storage: account data, notes, transcripts and audio.' },
  { heading: 'Vercel · EU (Frankfurt)', body: 'Application hosting. Data passes through while the app runs.' },
  { heading: 'Telnyx · United States', body: 'Phone numbers, connecting calls and sign-in codes. Recordings are held only until they are copied to our EU storage, then deleted. Standard Contractual Clauses.' },
  { heading: 'ElevenLabs · United States', body: 'Speech-to-text from call audio. Not used to train models. Standard Contractual Clauses.' },
  { heading: 'OpenAI · United States', body: 'Summaries, names, suggested next steps and answers from transcript text. Not stored by OpenAI and not used to train models. Standard Contractual Clauses.' },
  { heading: 'Expo · United States', body: 'Push notifications: a device token and notification text with no call content. Standard Contractual Clauses.' },
  { heading: 'Polar', body: 'Payments, as merchant of record: billing details only.' },
  { heading: 'Google · only if you connect it', body: 'Calendar events and Gmail drafts that you approve, under your own Google account terms.' },
];
