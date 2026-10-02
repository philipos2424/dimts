# Release 2: AI-first Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every call into specific, verified agreements and one next
step, add the memory check, promises, recap and Ask, and rebuild the app as
Today / Call / Ask in the Highland brand.

**Architecture:** The server keeps its pattern: Express routes, services
calling `completeJson`, and PGlite tests with mocked LLMs. Model output that
cites the transcript is accepted only through numbered line references that
the server resolves itself. The app keeps Expo Router and moves every screen
onto semantic light/dark tokens.

**Tech Stack:** Node 22, Express 5, PGlite, `node:test`, Expo 57 /
Expo Router (typed routes), `@expo-google-fonts/fraunces`,
`@expo-google-fonts/inter`.

**Spec:** `docs/superpowers/specs/2026-10-03-release-2-ai-first-design.md`

## Global Constraints

- Model output is accepted only through server-verified `source_lines`.
  Invented lines are dropped. Never fabricate timestamps: use `start: null`
  when timing is unavailable.
- At most 12 agreements per call. Values are clipped to 200 characters.
- The user's language is only `en` or `am`. Names, numbers and values stay
  as spoken.
- Ask: questions of 3–500 characters, at most 8 calls, at most 120 lines per
  call, 30 per user per hour. Nothing is stored server-side.
- Recap: generated from summary, agreements and action items only, never
  transcript text. It is sent by the user's share sheet; the server never
  sends it.
- New tables get RLS and backend grants (the existing guard test enforces this).
- Deleting a call clears `agreements`, `conflicts` and `recap` and removes
  its `promise_states`. The export includes them.
- Highland tokens are exactly the spec §5.1 table.
- `cd server && npm test` is green after every server task. `npx tsc --noEmit`
  and the web export are green after every app task.

## Review Focus

1. **A transcript that contains Amharic and English mixed.** Line references
   and quotes must still resolve exactly, so the line-splitting must not
   normalise text. Covered in Task 1.
2. **A conflict check whose model output references a previous call id that
   belongs to another user.** It must be dropped, because only ids the server
   sent are accepted. Covered in Task 2.
3. **An Ask question with no full-text matches and no recent calls** (a new
   user). The answer must be `grounded:false`, with no model call. Covered in Task 5.
4. **Promise status for an action item index that does not exist on the call.**
   Expect `404`. Covered in Task 3.
5. **The web app in dark mode with Amharic selected.** Text stays readable
   (Noto Ethiopic fallback) and contrast is acceptable. Covered in Task 12
   (browser check).

---

### Task 1: Agreements, language and timestamps

**Files:**
- Modify: `server/db/schema.sql`
- Modify: `server/services/summarize.js`
- Modify: `server/services/process-recording.js`
- Modify: `server/routes/me.js`
- Modify: `server/lib/users.js`
- Create: `server/lib/agreements.js`
- Test: `server/lib/agreements.test.js`
- Test: extend `server/services/summarize.test.js`
- Test: extend `server/routes/me.test.js`

**Interfaces:**
- Produces:
  - `resolveAgreements(raw: any[], transcript: string, turns: Turn[]) => Agreement[]`,
    where `Agreement = {kind, subject, value, said_by, quote, line, start:number|null}`
  - `summarize(transcript, { signal, language })` returns `...existing, agreements: RawAgreement[]`
  - `PATCH /api/me {language}` → `{language}`
  - `GET /api/me` includes `language`

- [ ] **Steps.** Write the tests first:
  - Line refs resolve to the exact line text, including a mixed
    Amharic/English line. Invalid refs drop only that agreement. Kinds
    outside the enum become `other`. The cap is 12. The value is clipped.
    `start` comes from `turns[line-1].start` when turns match the
    transcript, otherwise `null`.
  - The summarize prompt includes `Write ... in Amharic` when `language:'am'`.
  - `parseSummary` returns `agreements` (an empty array when missing).
  - The `PATCH /api/me` language is validated (`fr` gives `400`), persisted
    and returned by `GET`.
  - Processing stores `calls.agreements` with quotes and passes the owner's
    language.

  Then implement:
  - Schema: `calls.agreements JSONB`, `calls.conflicts JSONB`,
    `calls.recap TEXT`, and
    `users.language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','am'))`.
  - `resolveUser` selects `u.language`.
  - Processing: the claim query also selects the owner's language with
    `(SELECT language FROM users WHERE id=c.user_id)`. After the summary, run
    `resolveAgreements(summary.agreements, text, transcriptTurns({...call, transcript:text, transcript_data:raw, recording_url, transcript_recording_url: recording_url}))`
    and save it in the final UPDATE.

  Commit: `feat: verified agreements with timestamps, summaries in the user's language`

### Task 2: Memory check, first version

**Files:**
- Create: `server/services/consistency.js`
- Modify: `server/services/process-recording.js`
- Modify: `server/db/call-context.js`
- Test: `server/services/consistency.test.js`

**Interfaces:**
- Produces:
  - `checkConsistency(callId, {signal}) => Promise<Conflict[]>`, where
    `Conflict = {new_index, previous_call_id, previous_index, note}`
  - `contactContext` previous calls include `agreements`

- [ ] **Steps.** Write the tests first (PGlite + mocked `completeJson`):
  - With no previous agreements, the LLM is not called.
  - Model output referencing an unknown label, a foreign call or an
    out-of-range index is dropped (**Review Focus 2**).
  - A valid conflict is stored in `calls.conflicts`.
  - An LLM error is swallowed and `conflicts` stays null.
  - `contactContext` returns `agreements`.

  Then implement:
  - Previous agreements are labelled `P1..Pn` (each with call id and index,
    which are never shown to the model). New agreements are labelled `N1..Nk`.
  - The model returns
    `{conflicts:[{new:"N1", previous:"P3", note}]}`, and the server maps
    labels back to ids.
  - In processing, call it after `nameContact` inside the same
    `if (saved.rows.length)` block, best-effort.

  Commit: `feat: flag agreements that contradict earlier calls`

### Task 3: Promises

**Files:**
- Modify: `server/db/schema.sql`
- Modify: `server/db/supabase-privacy.sql`
- Modify: `server/db/supabase-backend-access.sql`
- Modify: `server/db/supabase-privacy.test.js`
- Create: `server/routes/promises.js`
- Modify: `server/create-app.js`
- Test: `server/routes/promises.test.js`

**Interfaces:**
- Produces:
  - `GET /api/promises` → `{you_owe: Promise[], waiting_on: Promise[]}`,
    where `Promise = {call_id, index, task, contact_id, contact_name, phone, created_at}`
  - `POST /api/promises/:callId/:index {status:'open'|'done'|'dismissed'}`

- [ ] **Steps.** Write the tests first:
  - The list splits by owner, excludes `null` owners, deleted or not-ready
    calls, calls older than 90 days, and `done`/`dismissed` items.
  - The POST checks ownership (another user's call gives `404`). An index
    past the end gives `404` (**Review Focus 4**). A bad status gives `400`.
    Setting `open` re-opens the item.

  Then implement the table `promise_states(call_id UUID REFERENCES calls(id)
  ON DELETE CASCADE, item_index INT, status TEXT CHECK(...), updated_at,
  PRIMARY KEY(call_id,item_index))`, the upsert, and the RLS and grant
  updates (the table count in the guard test becomes 20).

  Commit: `feat: promises tracker from call action items`

### Task 4: Recap

**Files:**
- Create: `server/services/recap.js`
- Create: `server/routes/recap.js`
- Modify: `server/create-app.js`
- Test: `server/routes/recap.test.js`

**Interfaces:**
- Produces: `POST /api/calls/:id/recap[?refresh=1]` → `{text}`

- [ ] **Steps.** Write the tests first:
  - Generation uses only the summary, agreements and action items. The
    prompt input must not contain the transcript.
  - The result is cached in `calls.recap`, and a second call does not hit
    the LLM. `refresh=1` regenerates it.
  - Another user's call gives `404`. A not-ready call gives `409`.
  - An LLM failure gives `502 recap_failed`.
  - The text is clipped to 1,500 characters.
  - It is rate-limited with `hit('recap:'+user, 20, 3600)`.

  The model returns `{text}`.

  Commit: `feat: recap text for the other person`

### Task 5: Ask

**Files:**
- Modify: `server/db/schema.sql` (GIN index)
- Create: `server/services/ask.js`
- Create: `server/routes/ask.js`
- Modify: `server/create-app.js`
- Test: `server/routes/ask.test.js`

**Interfaces:**
- Produces: `POST /api/ask {question}` →
  `{answer: string|null, grounded: boolean, citations: [{call_id, contact_name, created_at, line, quote, start}]}`

- [ ] **Steps.** Write the tests first:
  - Retrieval finds a call by a word in its transcript and never returns
    another user's calls.
  - A named contact pulls in their calls.
  - A user with no calls gets `grounded:false` and the LLM is not called
    (**Review Focus 3**).
  - Citations with a bad label or line are dropped. With no valid citations
    the result is `grounded:false` and `answer:null`.
  - A valid citation carries the quote and start time.
  - A question of 2 characters gives `400`. The 31st question in an hour
    gives `429`.
  - The prompt contains only labels `C1..`, never real ids.

  Then implement the retrieval SQL using
  `to_tsvector('simple', coalesce(summary,'')||' '||coalesce(transcript,'')) @@ websearch_to_tsquery('simple',$2)`
  ranked by `ts_rank`.

  Commit: `feat: Ask questions across your calls with verified citations`

### Task 6: Today list data, deletion and export

**Files:**
- Modify: `server/routes/calls.js`
- Modify: `server/services/scrub-call.js`
- Modify: `server/services/export-user.js`
- Test: extend `server/routes/calls.test.js`
- Test: extend `server/routes/call-deletion.test.js`
- Test: extend `server/routes/export.test.js`

**Interfaces:**
- Produces: list rows gain `agreements` (max 3), `conflict_count`,
  `next_step: {kind:'meeting'|'email'|'move', text}|null`,
  `capture: 'both'|'one_voice'|'no_audio'|'pending'|'none'`, and `contact_id`.

- [ ] **Steps.** Write the tests first:
  - Capture mapping for: ready, a failed call whose `error` starts with the
    silent message, a failed call with the single-channel or missing-signal
    message, processing, and no recording.
  - `next_step` prefers a pending follow-up proposal.
  - Deletion nulls `agreements`, `conflicts` and `recap` and removes
    `promise_states`.
  - The export includes `agreements` and `conflicts` per call, and
    `promise_states`.

  Then implement. The scrub adds those three columns and
  `DELETE FROM promise_states WHERE call_id=$1`.

  Commit: `feat: Today feed data; deletion and export cover release 2 fields`

### Task 7: Highland design system

**Files:**
- Modify: `package.json` (add `@expo-google-fonts/fraunces`, `@expo-google-fonts/inter`, `@expo-google-fonts/noto-sans-ethiopic` if needed)
- Rewrite: `src/theme.ts`
- Modify: `src/components/Txt.tsx`
- Create: `src/components/Card.tsx`
- Create: `src/components/Pill.tsx`
- Create: `src/components/Button.tsx`
- Create: `src/components/Moment.tsx`
- Create: `src/components/Screen.tsx`
- Modify: `app/_layout.tsx` (font loading, themed Stack)

**Interfaces:**
- Produces:
  - `useTheme() => {c: Tokens, dark: boolean}`
  - `Tokens` with keys `bg, card, line, ink, muted, brand, gold, ok, warn, danger, onBrand`
  - `Txt` props `{size, weight, tone: 'ink'|'muted'|'brand'|'gold'|'ok'|'warn'|'danger', serif?}`
  - `Button` `{label, onPress, variant:'primary'|'quiet'|'danger', busy, disabled}`
  - `Pill` `{tone, label}`
  - `Moment` `{quote, start, onPlay}`

- [ ] **Steps:**
  - Install the fonts with `npx expo install` (it resolves the
    SDK-compatible versions).
  - Rewrite the theme with the light/dark tables.
  - Keep `space`, `radius` and `type`.
  - Update every existing import of `color` to `useTheme().c`. This touches
    many files, so make the change mechanically and verify with `tsc`.
  - `PrimaryButton` becomes a thin wrapper of `Button`, or its imports are
    replaced.
  - Verify with `tsc` and the web export.

  Commit: `feat(app): Highland design system with light and dark themes`

### Task 8: Navigation and Today

**Files:**
- Rewrite: `app/(tabs)/_layout.tsx`
- Rewrite: `app/(tabs)/index.tsx`
- Delete: `app/(tabs)/notes.tsx`
- Delete: `app/(tabs)/contacts.tsx`
- Create: `app/(tabs)/ask.tsx` (a placeholder screen is not allowed; it is
  implemented in Task 10, so this task only registers the route once Task 10
  exists, which means Tasks 8 and 10 are done together)
- Create: `src/components/CallCard.tsx`
- Create: `src/components/PromisesStrip.tsx`
- Modify: `src/api.ts` (types and functions: `listCalls` fields,
  `getPromises`, `setPromise`, `patchLanguage`, `getRecap`, `ask`)
- Modify: `src/useCalls.ts`

- [ ] **Steps:** follow spec §5.2–5.3. A card tap opens `/call/[id]`. A name
  tap opens `/person/[contact_id]`. Approve opens the call detail at the
  follow-up section (`/call/[id]?focus=next`). Verify with `tsc` and the
  export.

  Commit: `feat(app): Today feed with call cards and promises`

### Task 9: Call detail

**Files:**
- Rewrite: `app/call/[id].tsx` (keep every existing behaviour: player,
  recovery, retry, export, delete, end call, follow-up review)
- Create: `src/components/AgreementList.tsx`
- Create: `src/components/ConflictList.tsx`
- Create: `src/components/RecapButton.tsx`
- Modify: `src/api.ts` (`CallDetail` gains `agreements`, `conflicts`)
- Modify: `server/routes/calls.js` (detail returns `agreements`, `conflicts`
  and `contact_id`), with a test

- [ ] **Steps:** follow spec §5.4. `?t=seconds` seeks the player on load.
  `RecapButton` calls `getRecap`, then `Share.share({message})`.

  Commit: `feat(app): call detail built around what was agreed`

### Task 10: Person page and Ask

**Files:**
- Create: `app/person/[id].tsx`
- Create: `app/(tabs)/ask.tsx`
- Modify: `server/routes/contacts.js` (`GET /:id` returns the contact plus
  its calls, agreements and open promises), with a test

- [ ] **Steps:** follow spec §5.5–5.6. Commit:
  `feat(app): person page and Ask`

### Task 11: Restyle remaining screens; language sync

**Files:**
- Modify: `app/onboarding.tsx`, `app/settings.tsx`, `app/first-call.tsx`,
  `app/in-call.tsx`, `app/(tabs)/dialer.tsx`, `app/terms-accept.tsx`,
  `app/privacy-request.tsx`, and the remaining components
- Modify: `src/AppContext.tsx` (`setLang` also calls `patchLanguage`, and
  sign-in adopts the server's language)

- [ ] **Steps:** every screen uses tokens and `Screen`. Remove dead i18n keys
  and components (`notes`, `contacts` tab strings). `tsc` and the export
  must pass.

  Commit: `feat(app): Highland across every screen; language synced to the server`

### Task 12: Browser verification

- [ ] **Steps:**
  1. Build the web export and serve it with the server against PGlite seed
     data, using a local script
     `server/scripts/dev-seed.js` that creates a user, session, contact and
     two ready calls with agreements, a conflict and promises. **No real
     providers.**
  2. Open it at 390px width in light and dark, in English and Amharic.
  3. Fix anything broken with a test where possible.
  4. Record screenshots in the PR description.

  Commit any fixes.

## Self-review notes

Spec coverage:

| Spec section | Task |
|---|---|
| §4.1 | 1 |
| §4.2 | 1, 11 |
| §4.3 | 2 (+9 UI, +10 briefing) |
| §4.4 | 3 (+8 UI) |
| §4.5 | 4 (+9) |
| §4.6 | 5 (+10) |
| §4.7 | 6 (+8) |
| §5.1 | 7 |
| §5.2–5.3 | 8 |
| §5.4 | 9 |
| §5.5–5.6 | 10 |
| §5.7 | 11 |
| §6 | 1, 3, 5, 6 |
| §8 | every task, plus 12 |
