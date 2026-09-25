# How recordings & audio is wired

> Doc: `/docs/wiring/recordings-audio.md`
> Last updated: 2026-09-25 — **§3 added: ONE shared player** (`shared/recording-view.js`, Inbox slice 2b) for all four places on the advisor board; **LIVE on prod** since `103a645`; the in-place built-in player (§3) on staging only.
> Status: §3 verified vs `103a645` (code + test.* + read-only prod load). §1–§2 last verified vs `bea25cf` (2026-07-30) plus the 2026-09-17 auth notes — not re-checked this session.

## 0. In one line
All audio is served through server endpoints with short-lived signed URLs; the
`recordings` table is locked down and never touched directly by the client.

## 1. Security model
- Postgres RLS is row-level and **cannot hide a column** — so `recordings` is
  default-deny with **zero policies**; all audio goes through server endpoints.
- `remote_url`, `storage_path`, `last_error` **never leave the server**. `vehicle_id`
  is an internal shop id and *is* returned (not in the secret class).
- Signed URLs: service-role, ids only, ready-only, expire in **5 minutes**.
- **Both board endpoints now require a signed-in active employee** (2026-09-17, Security
  Phase 3): `requireUser` runs first in `api/recording-links.js` and `api/recording-assign.js`,
  so a caller without a live Supabase session mapped to an `active` `employees` row gets
  `401 {error:'unauthorized'}` and no URL is ever signed. Until then `recording-links` answered
  an unauthenticated POST — **an empty `call_ids` POST returned `200 {results:[]}`**, and a POST
  with guessed ids would have signed playback URLs for real customer calls. The advisor board
  sends the token through `cdAuthFetch` (`shared/auth-fetch.js`). A valid session is not enough
  on its own: the KiKi app shares this project's `auth.users`, hence the `employees` mapping.

- **The fetch cron and the backfill fail CLOSED.** `api/fetch-recordings.js` (`cronAuthorized`)
  and `api/backfill-recordings.js` (`authorized`) require `Authorization: Bearer <CRON_SECRET>`.
  If `CRON_SECRET` is **unset**, both refuse with 401 and log an error — they no longer run
  unauthenticated (changed 2026-09-17; locked by `api/recordings-jobs.test.js`). Both use the
  service-role key, so an open endpoint would bypass the default-deny RLS for anyone.

## 2. Which vehicle a recording belongs to (precedence, highest first)
- Session assignment
- Persisted `vehicle_id` &nbsp;**← a human said it, so it beats derivation**
- `calls.ro_id` derivation
- "vehicle unknown" (null = nobody has said, **never "no"**)

Notes:
- **Unassigned recordings show under every vehicle chip** — the original-complaint call
  predates its RO, so hiding it defeats the oldest-first section.
- Assigning a vehicle is **blocked on unconfirmed rows** (phone-matched, nobody
  attached). The person link comes before the vehicle link. Enforced server-side.
- Assignments **must survive reload** — `recording-links` returns `vehicle_id` so a
  persisted assignment re-displays. ("Durable but not re-displayed" was the bug that bit
  us — a stale read must never authorize a write.)

## 3. The one player on the advisor board (Inbox slice 2b, 2026-09-25)
Four places show a call recording; since slice 2b they all use **`shared/recording-view.js`**, and
`shared/recording-player.js` still decides the state (ready / pending / failed / none — pure).
- **One reader:** `cdRecordingIndex(callIds, tag)` near the top of the board's main script is the ONLY call to
  `api/recording-links` (through `cdAuthFetch`, signed-in employee) → `fetchRecordingIndex`: ids cleaned, sent in
  **batches of 50** (the endpoint's `MAX_CALL_IDS`); a failed batch is logged and those calls just show nothing.
- **▶ Play → the browser's own player, in place** (Cris, 2026-09-25: recordings work "like any other audio") —
  **Call Log** (`deskRec`), **RO Call History** (`roRec`), **customer record** timeline (`custRec`), each made by
  `cdRecordingPlayer(place)` → `createButtonPlayer`. Each row keeps its compact button (`recButtonHtml`: ready =
  `▶ Play (m:ss)`, pending = disabled "● Recording…", failed = quiet "Recording unavailable", **no recording row =
  nothing**). A tap swaps that button **in place** for an `<audio controls>` (`.rec-player`: play/pause, a bar to
  drag, the time) and starts it; if the browser blocks the autoplay, the player is open and its ▶ starts it.
  - **ONE open player on the whole board** (`closeOpenPlayer`): opening another recording — in any of the three
    places — pauses the first and puts its button back (the same button element, so its click still works).
  - **Leaving collapses it:** closing the Call log (`cdRecordingStop('desk')`), opening another RO or leaving the
    RO (`'CdRO'`), the customer list / back / a record reload (`'cust'`), any sidebar navigation (any place). A
    place redrawing its rows (`reset()`) closes its own; a player whose row was redrawn off the page stops itself
    on its next `timeupdate` (no invisible audio keeps talking).
  - A link that aged out (5 min) → the player's `error` → **one** fresh link into the same player; a second failure
    puts the button back. No link at all → the button stays. The latest tap wins while a fresh link is loading.
  - The old hidden per-place `<audio>` elements (`#deskRecAudio`, `#cdRoRecAudio`, `#custRecAudio`) are gone.
- **Tray call card** (`loadInlineRecording`, [[inbox-calls]] §4) — an inline `<audio controls>`; pending →
  "arrives a few minutes after the call ends"; **no row** → "shows up after the call ends" for the first
  `NO_RECORDING_AFTER_MS` (30 min) from the call's start, then **"No recording"** — the row is created by the
  CTM *end* webhook only when the call ended WITH audio (`api/ctm-webhook.js` `mapRecordingRow` /
  `insertRecording`), so no row after that means none is coming; failed — or ready but no link could be signed (the file isn't in storage) → "couldn't be
  fetched"; a dry-run card → "none (test call)". Re-checked every 45 s while open until ready; one fresh link per card on a playback error.
- Nothing in the module reads or writes on its own (the request is injected) — locked by
  `shared/recording-view.test.js`.

## Known gaps & open questions (as of 2026-09-25)
- Facebook voice messages are still a "🎤 Voice message — view" link in the Messenger tray, not this player
  (their links come from Meta, not `api/recording-links`) — slice 2c.
- "No recording" after 30 min assumes calls end within 30 min; a longer call that then ends with audio shows up
  anyway on the next 45 s re-check while its card is open.

## Where it lives in the code
- `api/recording-links.js` — service-role reader; signs only `'ready'` rows, TTL `SIGNED_URL_TTL_SECONDS`=300s;
  `publicRow` whitelists `call_id, status, duration_seconds, playback_url, vehicle_id` (locked by `recording-links.test.js`)
- `api/recording-assign.js` — assign/clear a vehicle; server-side ownership gate rejects a call with no
  confirmed `customer_id` (409) and a vehicle not owned by that customer (403)
- `shared/recording-player.js` — pure render-state (ready / pending / failed)
- `shared/recording-view.js` (+ `.test.js`) — the ONE player (§3): `fetchRecordingIndex`, `recButtonHtml`,
  `createButtonPlayer`, `inlineRecordingView`, `loadInlineRecording`; the board's `cdRecordingIndex` /
  `cdRecordingPlayer` in `advisor-board.html`
- The **precedence resolver** (`custRecVehId`) lives in `advisor-board.html` (≈ line 10795 as of 2026-09-25); the
  "unassigned shows under every chip" filter is `filterRecordingsByVehicle` in `shared/customer-record.js`
- Schema: `20260729_recordings.sql` (table, RLS on + zero policies, private bucket),
  `20260729_recordings_links.sql` (`vehicle_id`, `ro_id` columns)

## Session change log
- 2026-09-25 — (staging) the three ▶ Play places now open the browser's own `<audio controls>` in place of the button (play/pause, drag, time), one open player board-wide, collapsed on leave / redraw; hidden per-place `<audio>` removed. Link logic and states unchanged. Tray card unchanged.
- 2026-09-25 — **slice 2b shipped to prod** (Cris's OK on test.*): fast-forward `d600a5e..1a2cd8a` (code = `103a645`; `1a2cd8a` = docs-only on top). www / board. / apex `/api/version` = `1a2cd8a` (~30 s after the push); `advisor-board.html`, `shared/recording-view.js` (+test) and `shared/inbox-calls-logic.test.js` byte-identical to `103a645`, the two docs to `1a2cd8a`, on all three; CLAUDE.md 404. Prod read-only (pane not signed in, nothing written, no RO opened): tray folded, strip drawn, `recording-view.js` + `recording-player.js` 200, `window.RecordingView` + `cdRecordingIndex` / `cdRecordingPlayer` present, no console errors. Real playback on prod not yet heard (no sign-in in the pane) — Cris to click a real one.
- 2026-09-25 — slice 2b driven on test.* at `103a645` (ZZ Test Advisor): served files byte-identical; prod untouched (`d600a5e`). **The sandbox has the `recordings` rows but NOT the audio files** (201 ready rows, every signed link comes back null — storage objects were never copied), so nothing real can play on test.*. Real reader, real clicks: customer record ▶ → exactly one fresh-link request, nothing plays, highlight clears, no error (same as before); tray card for call 284 → "couldn't be fetched"; TEST RELOAD (no row, yesterday) → "🎧 No recording". Then with the page's links reader wrapped to hand back a generated tone (real server read, link swapped; page memory only), real clicks: customer record ▶ plays / tap again stops / highlight clears; RO Call History (2 rows, one batched call) 284 plays then 117 takes over; Call Log Aug 12 (10 rows, one batched call, 7 ▶ / 3 empty) with a dead first link → exactly one fresh link → plays; tray card with a dead first link → the error fetched one fresh link → plays.
- 2026-09-25 — §3 (Inbox slice 2b, staging): the four copied fetch/draw/relink blocks on the advisor board (Call Log, RO Call History, customer record, tray call card) replaced by `shared/recording-view.js` + one links reader `cdRecordingIndex`. Call Log + RO Call History now batch by 50 like the customer record; the tray card's "no recording" case fixed ("No recording" after 30 min). No DB change, no new write.
- 2026-09-17 — §1: `api/recording-links.js` + `api/recording-assign.js` now require a signed-in active employee (`api/_lib/require-user.js`); the advisor board's three links call sites and the assign call go through `cdAuthFetch`. Signing rules, precedence and the crons are unchanged.
- 2026-09-17 — Cron auth made fail-closed in `api/fetch-recordings.js` + `api/backfill-recordings.js`
  (missing `CRON_SECRET` → 401, was: run unauthenticated); §1 bullet added. Rest of doc not
  re-verified this session.
- 2026-07-29 — Slice B play button (`4f76540`); Slice C RO Call History play buttons
  (`fe2b9c3`); customer-record oldest-first recordings (`4ef6544`); unknown-vehicle under
  every chip + assign endpoint (`966d033`); assignments survive reload (`bea25cf`).
- 2026-07-30 — Verified vs `bea25cf`: security model, the four-level precedence, the server-side
  assign gate, and the 5-min ready-only signed URLs all confirmed against code. No claims changed;
  added precise code locations. All five changelog commit hashes confirmed to exist.
