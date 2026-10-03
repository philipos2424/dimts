# Release 2: AI-first redesign (design)

**Date:** 3 October 2026
**Status:** Approved by the founder for planning
**Parent:** `2026-10-02-dimts-roadmap.md`
**Base:** `caller-mvp` at `a1aa2d6` (release 1 merged, 310 tests passing)

---

## 1. Goal

Dimts should feel like an assistant reporting back, not a phone with features.
After every call you see three things: who it was, what was agreed (the actual
numbers and dates), and the one thing to do next, with an **Approve** button.
The UX stays simple: three tabs, no settings to learn, and every AI claim
links to the moment in the call it came from.

## 2. Lessons from the reviews this release must meet

From `docs/CALL_RECORDING_REVIEW_RESEARCH.md` plus the Quo, Granola and Otter reviews:

| Complaint | Answer in this release |
|---|---|
| One-sided or silent recordings shown as success | Every card shows **✓ Both voices** or **⚠ Only one voice / No audio**, taken from the existing quality check |
| Generic summaries | Agreements are extracted as **specific facts** (subject + value + who said it), each with a verified quote and a timestamp |
| Wrong speakers | Dual-channel capture means speakers are never guessed. We say so in the UI ("You" / the contact's name) |
| AI-assigned names can't be fixed | One tap on the name opens an inline edit, saved as `name_source='user'` (the existing contact PATCH) |
| Need to find things across calls | **Ask** tab: plain-language questions, answers cite the call and the second it was said |
| Rating prompts and paywalled exports | None. Export stays free (release 1) |

## 3. Scope

**In:**
- Highland design system (light and dark)
- Today / Call / Ask tabs
- call cards
- redesigned call detail
- person page
- agreements with evidence and timestamps
- memory check, first version (briefing before the call, contradiction flags after it)
- promises tracker
- recap to the other person (share sheet)
- summaries in the user's language
- Ask

**Out:**
- billing (release 3)
- the live memory check during calls, in-app calling, and AI answering missed calls (release 4)
- automatic push reminders for promises (they appear in Today; push comes later)
- server-side sending of recaps (the user's own share sheet sends them, so no SMS cost or sender compliance)

## 4. AI pipeline (server)

### 4.1 Agreements
`summarize()` gains an `agreements` array. Each entry:

```json
{ "kind": "price|quantity|date|time|amount|deliverable|other",
  "subject": "unit price for 200 units", "value": "450 birr",
  "said_by": "User|Caller", "source_lines": [12] }
```

- `source_lines` refer to the numbered transcript, the same technique
  `followups.js` already uses. The server resolves them to exact quotes and
  **drops any agreement whose lines do not exist**. A model can't invent a
  quote this way.
- Timestamps: `transcriptTurns()` reconstructs the transcript line by line,
  so line *n* is turn *n*. Each agreement gets `start` (seconds) from that
  turn when timing is available, otherwise `null`. Timing is never invented.
- Stored in a new `calls.agreements JSONB` column. A maximum of 12 per call,
  and values are clipped to 200 characters.
- The existing ambiguity rule applies to agreements too: no AM/PM, date,
  currency or timezone is added unless it was spoken.

### 4.2 Summaries in the user's language
- `users.language` (`en` or `am`, default `en`) is set from the app's language
  setting with `PATCH /api/me { language }`.
- The summary prompt gets: *"Write summary, next_moves, agreements.subject and
  action_items.task in {English|Amharic}. Keep agreements.value, names and
  numbers exactly as spoken."*
- The transcript stays in the language that was spoken.

### 4.3 Memory check, first version
- **Before the call:** `contactContext()` (used by the existing briefing)
  also returns each previous call's `agreements`. The briefing UI lists the
  last agreements as "Last time with Abebe: …".
- **After the call:** once notes are saved, `checkConsistency(call)` runs as
  best-effort work like contact naming:
  1. It loads up to 20 agreements from this contact's previous 5 ready calls,
     each with `{call_id, index, subject, value, said_by, created_at}`.
  2. If there are none, it stops.
  3. Otherwise it asks the LLM which new agreements **conflict** with a
     previous one: same subject, different value. It returns
     `[{new_index, previous_call_id, previous_index, note}]`.
  4. The server keeps only entries whose indexes and call ids exist in the
     data it sent, and stores them in `calls.conflicts JSONB`.
  5. It is skipped when the call has no contact or no agreements. Failure
     never fails the call.
- The card and call detail show: *"⚠ Today: 450 birr. On 3 Oct Abebe said
  500 birr."* with ▶ buttons for both moments. The wording is always
  neutral.

### 4.4 Promises
- These come from the existing `action_items` (`owner` = `User`/`Caller`).
- A new table `promise_states(call_id, item_index, status, updated_at)`
  holds `open | done | dismissed`. A missing row means `open`.
- `GET /api/promises` returns open items from ready, undeleted calls in the
  last 90 days, split into `you_owe` (owner `User`) and `waiting_on` (owner
  `Caller`), each with call id, contact name and created_at. Items whose
  owner is `null` are excluded.
- `POST /api/promises/:callId/:index { status }` sets the status.
  Ownership is checked.

### 4.5 Recap to the other person
- `POST /api/calls/:id/recap` returns `{ text }`. It is generated once and
  cached in `calls.recap`, and `?refresh=1` regenerates it.
- The LLM writes 3–6 short lines in the user's language from the summary,
  agreements and action items: greeting, what we agreed (bullets), next
  steps, sign-off.
- It contains no transcript text and no internal notes. The prompt is
  forbidden from adding anything that is not in the agreements or action
  items.
- The app opens the native share sheet (`Share.share`) with the text, so
  the user chooses SMS, WhatsApp or email. The server never sends it.

### 4.6 Ask
- `POST /api/ask { question }`, with a question of 3 to 500 characters and a
  limit of 30 per user per hour.
- **Retrieval:**
  1. Run a Postgres full-text search with the `simple` configuration over
     `summary || agreements text || transcript` for the user's ready,
     undeleted calls, using `websearch_to_tsquery('simple', question)`.
     Take the top 6 by rank.
  2. If the question names a known contact (case-insensitive match on
     `display_name`), include that contact's last 3 calls.
  3. If there are fewer than 3 results, fill with the most recent calls.
     There are at most 8 calls in total.
- **Prompt:** each call is sent as a header (id label `C1..C8`, contact,
  date, direction) plus numbered transcript lines, truncated to 120 lines per
  call (agreement lines first, then the start). The model returns
  `{ answer, citations: [{call: "C3", line: 12}] }`.
- **Verification:**
  - Labels are mapped back to real call ids. A citation pointing at a label
    or line we did not send is dropped.
  - Citations get the quote text and `start` seconds (via transcript turns).
  - If none survive, the answer is returned with `grounded: false` and the
    UI says "I couldn't find this in your calls" and does not show the
    model's text.
- Questions and answers are **not stored**: there is no chat history on the
  server. The app keeps the current session's conversation in memory only.

### 4.7 Today feed data
`GET /api/calls` (list) adds:
- `agreements` (first 3)
- `conflict_count`
- `next_step`: the first pending follow-up proposal's kind and title, else the first `next_moves` item
- `capture`: one of
  - `both` (status ready)
  - `one_voice` (failed with a single-channel or missing-signal quality error)
  - `no_audio` (silent)
  - `pending` (processing)
  - `none` (no recording)
- `contact_id`

This is computed in SQL and JavaScript from existing columns. There is no
new list endpoint.

## 5. App

### 5.1 Highland design system
`src/theme.ts` is rewritten around semantic tokens with light and dark
values, chosen by `useColorScheme()`. The key tokens:

| Token | Light | Dark |
|---|---|---|
| `bg` | `#fbfaf6` | `#0f1a15` |
| `card` | `#ffffff` | `#16241d` |
| `line` | `#e3e6dc` | `#24372d` |
| `ink` | `#13261d` | `#eef2ec` |
| `muted` | `#5b6b62` | `#9fb0a6` |
| `brand` | `#13392a` | `#7fc4a0` |
| `gold` | `#c8922e` | `#d9a648` |
| `ok` | `#2f7a4f` | `#7ee0a8` |
| `warn` | `#b4690e` | `#f0b45a` |
| `danger` | `#b3261e` | `#f2867f` |

- **Type:** Fraunces (headings, names) and Inter (body), from
  `@expo-google-fonts/*`. Noto Sans Ethiopic stays as the fallback for
  Amharic text. Sizes stay as they are.
- **Components:** `Card`, `Pill` (capture status), `Button` (primary,
  quiet, danger), `Txt` (adds `serif` and `tone`), `Moment` (▶ quote +
  timestamp, which seeks the player), `Screen` (safe area + background).
- Every screen moves to the tokens. The old `color.*` names are removed.

### 5.2 Navigation
- **Tabs:**
  - **Today** (`app/(tabs)/index.tsx`)
  - **Call** (`app/(tabs)/dialer.tsx`, restyled)
  - **Ask** (`app/(tabs)/ask.tsx`)
- `notes.tsx` and `contacts.tsx` are removed as tabs. People open through
  `app/person/[id].tsx`.
- The header shows the ድምፅ wordmark on the left and an avatar circle (the
  phone number's initials) on the right, which opens Settings.

### 5.3 Today
1. **Promises strip** (only if any are open): "You owe 2 · Waiting on 1".
   Tapping it expands the list. Each row has Done and Dismiss.
2. **Call cards**, newest first:
   - name (tap to fix) · company
   - capture pill
   - direction, duration and time
   - up to 3 agreements as "subject: **value**"
   - conflict line if any
   - next step with **Approve** (calendar or email proposal) or **Open**
3. A failed recording keeps its card, showing "Recording kept. No notes
   made. What happened?" which links to call detail recovery.
4. **Empty state:** the business number plus "Make your first call".

### 5.4 Call detail
In order:
1. **Header:** name, capture pill, ▶ play.
2. **What was agreed:** agreement rows, each with a ▶ moment.
3. **Conflicts:** shown if any, with both moments.
4. **Next steps:** the existing follow-up review, plus a **Send recap**
   button that opens the share sheet.
5. **Promises from this call:** with Done.
6. **Summary.**
7. **Transcript:** collapsed by default.
8. **Footer:** Export · Delete.

Existing recovery, retry, deletion and end-call behaviour is kept and
restyled.

### 5.5 Person page
- Name and company, editable inline.
- Phone number, with **Call**.
- "Last time" briefing: the agreements from the most recent call.
- Open promises with this person.
- Call history.
- **Delete this person** (release 1 endpoint) behind a confirmation.

### 5.6 Ask
- A chat layout with three suggested questions as chips when empty: "Who am
  I waiting on?", "What did we agree last week?", "Prices mentioned this month".
- Answers show the cited moments as chips (contact · date · mm:ss) that open
  the call detail at that time (`/call/[id]?t=123`).
- Ungrounded answers show the fallback text.

### 5.7 Language
The existing language toggle (Settings) also calls `PATCH /api/me
{ language }`. On sign-in, the server's language wins if it is set.

## 6. Data changes

- `calls.agreements JSONB`
- `calls.conflicts JSONB`
- `calls.recap TEXT`
- `users.language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','am'))`
- `promise_states` table (with RLS and backend grants like every other table)
- A GIN index for full-text search:
  `CREATE INDEX IF NOT EXISTS calls_search_idx ON calls USING gin (to_tsvector('simple', coalesce(summary,'') || ' ' || coalesce(transcript,'')))`

  The query uses the same expression so the index is used. Agreements text
  is matched separately with `ILIKE` on a short list.

The export (release 1) adds `agreements`, `conflicts` and `promise_states`.
Deleting a call clears `agreements`, `conflicts` and `recap` and deletes its
promise states.

## 7. Error handling

| Failure | Behaviour |
|---|---|
| Model returns an agreement with bad line refs | That agreement is dropped; the others are kept |
| Consistency check fails | Logged; the call stays `ready` with no conflicts |
| Ask retrieval finds nothing | Returns `grounded:false`, and the UI shows the fallback |
| Recap generation fails | `502 recap_failed`; the UI says "Couldn't write a recap, try again" |
| Old calls without agreements | Cards fall back to the summary's first sentence |

## 8. Testing

- Server: PGlite plus mocked LLM, following the existing pattern:
  - agreement parsing and line verification
  - timestamp mapping
  - language instruction
  - conflict filtering (made-up ids dropped)
  - promises listing, status and ownership
  - recap caching and the no-transcript rule
  - Ask retrieval, citation verification and the ungrounded fallback
  - the list's `capture` mapping
  - deletion clearing the new columns
  - export including them
- App: `tsc --noEmit` and the web export. Each screen gets checked with the
  web build in a browser at phone width, light and dark.

## 9. Rollout

Additive schema only, applied along with release 1's. A PR goes into
`caller-mvp`, and the same production go-ahead covers both releases.
