# How incoming calls live in the Inbox tray
> Doc: `/docs/wiring/inbox-calls.md`
> Last updated: 2026-09-24 — created with **slice 1** of "calls into the Inbox tray" (Cris's design, the
> "Front Desk Inbox Tray" mockup screens 1, 2 and 4). Verified vs commit `d5ddc37` (driven on test.*, staging only).
> Status: 🟡 **staging only** (test.*) — Cris reviews before `main`.
> Related: [[messenger-tray]] (the tray this lives in), [[call-window-desk]] (the call card's writes, the Desk
> lanes it feeds — unchanged), [[recordings-audio]] (the recording on screen 2), [[desk-pad]] (the bottom
> drawer beside the tray).

## 0. In one line
An incoming call no longer floats over the board: it rings as a pinned caller-ID card at the top of the right-hand
**Inbox** tray, then waits in the tray's **"Needs handling"** list until someone notes it — and the full call card
(recording, note, next step) opens inside the tray.

## 1. The tray's looks (with calls)
- **Folded strip = the default** (mockup screen 4): a slim full-height column on the right (48 px) with a
  **📞 badge + count** and the **f badge + count** (a badge with nothing waiting is greyed), and "INBOX" written
  down it. It **pushes the board** (`body.mtray-tucked` → `.main-area` padding-right 48 px) and the bottom drawer
  stops beside it (`--dp-right: 48px`) — nothing sits behind anything. Click it → the tray opens.
- **Page load / new tab = folded**, even with calls or threads waiting (the badges show them) — Cris,
  2026-09-24. **The tray opens by itself only for something NEW while the page is open:** a call **ringing
  now** (inside its 2 minutes — `add()` reports `ringing`; a call brought back by the backfill after a reload
  joins the list quietly) or a newly arrived Facebook message. Open = 340 px, pushing the board as before.
- **It folds back to the strip by itself** when the last waiting item is handled (no call on this board and no
  Facebook thread you can still reply to — threads past the 24 h window don't count, [[messenger-tray]] §2).
  It is never "hidden" after the first load.
- Header: **"Inbox · N waiting"** (calls + Facebook threads you can still reply to).

## 2. Ringing — the pinned caller-ID glance (screen 1)
- A call **rings for 2 minutes** from its `started_at` (`RING_MS`; a dry-run card with no start rings from when
  it arrived). The **newest ringing call nobody has opened yet** gets the pinned glance at the top of the tray
  (`pickRinging`); other ringing calls are rows marked "ringing".
- The glance (`callerGlance`, from what the card already loaded — no extra query): "● Incoming · Direct" + a tag
  (Returning / Customer / New), **name** (or "New caller" + the caller-ID name), **phone**, **Vehicle**,
  **In shop now** (newest RO that isn't closed or declined: "RO #6089 · 2014 Ford F-250 · Active RO"),
  **Last visit** (newest closed RO: "Mar 3 · RO #5890 · 2014 Ford F-250", or the customer's last invoiced date),
  **Heads up** (a declined estimate, else an open estimate, else "None").
  "Last visit" uses the RO's `closed_at` — the set-once billed date, fine for "when were they last in".
- **Answered → notepad** opens the full card (§4); the call is then "answered" on this board and stops pinning.
  **Customer record** (matched callers only) opens the record.
- The strip's 📞 badge pulses while a not-yet-opened call rings.

## 3. "Needs handling" — the list (per board until slice 5)
- One list under the glance: **call rows first**, then the Facebook threads continue it (one "Needs handling"
  heading). Rows: 📞 name (customer > caller-ID name > number), time, and source · status.
- **Order (Cris, 2026-09-24):** calls with **NO NOTE YET on top** (newest first), then noted ones (newest first)
  — `orderNeedsHandling`. When a ringing call ends with nobody typing, it drops to the **top** marked
  "no note yet" (amber).
- **A call never disappears just because nobody typed anything.** The card's × and Close only remove a call that
  has been **noted** — a note, a next step (Call back / Coming in) or filed to an RO; all of those go through the
  card's `saveNote`, which stamps `calls.noted_at`. On an un-noted call, × / Close say "Add a note or pick what
  happens next first — then Close." and keep it (`tryClose`). Slice 5 adds "Done" and "Not a customer" as the
  other ways out.
- **Per board, not shared (until slice 5):** nothing in the database says a call was handled, so each advisor's
  board keeps its own list; closing a noted call on one board doesn't close it on another.
- **Survives a reload:** the card backfill now brings back **today's** untouched real calls (`started_at` since
  local midnight, `noted_at` null, `resolved_at` null, `ctm_call_id > 0`), newest 25 — on page load (1.5 s in),
  on focus / visibility, and on the 60 s health tick. (It was the last 15 minutes, 5 cards.) A call closed on
  this board after being noted has `noted_at` set, so it never comes back.

## 4. The opened call — the card inside the tray (screen 2)
- Tapping a row (or "Answered → notepad") moves the **same call card** into the tray's detail view ("‹ All"
  puts it back). It is the callerCard code in `advisor-board.html`, unchanged in what it saves:
  - **🎧 Recording** — `api/recording-links` (signed-in employee only) through `cdAuthFetch`; a player when the
    file is ready; "arrives a few minutes after the call ends" until then (the 5-minute fetch cron), re-checked
    every 45 s while the card is open; one fresh link on a playback error (links last 5 min).
  - **Call note** — autosave as before.
  - **Anything left to do?** — **Call back** (`quoted_callback`) · **Coming in** (`dropping_off`) · **Done
    (coming)**. Same `next_step` values, date UI, echo and Desk lanes as before. The two old chips ("Checking on
    their car", "Price shopper") are hidden unless a call already has one. "Done" needs its own column — slice 5.
  - **Filed to RO** — unchanged.
  - **Attach… · Start RO · Not a customer** — shown as "coming" (they need new writes — slice 5).
  - **Close** — only once the call is noted (§3).
- Cards are **moved, never re-drawn** (`shared/inbox-calls.js`), so a typed note and every listener survive; a
  card with the keyboard focus in it is never moved by the 5 s tick.

## 5. Writes — unchanged, and temporary
Slice 1 changes **where** the card is drawn, not what it writes: the same direct browser updates to `calls`
(`saveNote`, `persistCustomer`) — anon/authenticated UPDATE on `calls` is still open. **Cris's decision
(2026-09-24): allowed until the security slice** moves every `calls` write to `api/calls.js` (requireUser,
fixed columns, server stamps) and removes that permission. The tray code (`inbox-calls.js`) reads and writes
nothing itself (test-locked). The card still never writes `resolved_at` (test-locked).

## Known gaps & open questions (as of 2026-09-24)
- **On test.* a real ring doesn't pop live** — the sandbox's `supabase_realtime` publication seems to lack
  `calls` (a real webhook row was created, the channel said "joined", no event arrived — the same gap
  `repair_orders` had, [[staging-db]]). The backfill (page load, focus, 60 s tick) still brings it in. Prod
  has `calls` in the publication (cards pop live there today). Fix = add `calls` on the SANDBOX only (Cris,
  the prod-vs-sandbox publication comparison query).
- **Per-board "Needs handling"** — shared state needs `handled_at` / `handled_by_name` (slice 5).
- **Answered vs missed** isn't known yet — CTM's `call_status` from the end webhook (slice 4: missed =
  `no answer`, `busy`, `failed`, ~19 % of calls).
- **Done / Attach / Start RO / Not a customer** show as "coming" (slice 5).
- Below 900 px the open tray overlays the board (as before); the folded strip still pushes.
- A modal (z 3000) covers the tray (z 2900) — a call that rings while a modal is open shows once the modal
  closes (the old floating cards sat at z 4000, above modals; now nothing call-related is above a modal).

## Where it lives in the code
- `shared/inbox-calls.js` — `mountCallSlot({ section, onChange, timeLabel })`: the ringing glance, the rows, the
  detail view, the hidden card holder; moves cards; reads/writes nothing.
- `shared/inbox-calls-logic.js` (+ `.test.js`) — `RING_MS`, `ringStartMs`, `isRinging`, `pickRinging`,
  `orderNeedsHandling`, `callRowName`, `callRowStatus`, `stripCalls`, `callerGlance`.
- `shared/messenger-tray.js` — mounts the calls area above the Facebook list, `window.cdCallInbox`, takes
  `window.cdCallInboxPending`, the strip badges, fold-to-strip, the shared heading; `messenger-tray.css` — the
  strip column, the glance, the card-in-tray look.
- `advisor-board.html` — the callerCard IIFE: `placeCard` / `hasCard` (hand-off to the tray), `setGlance`,
  `tryClose`, `loadCardRecording` / `wireCardInTray`, the next-step chips, the backfill (today, 25), and the
  richer read in `loadDetail` (RO `closed_at` + vehicle). The floating `#callCardStack` (z 4000) is gone.
- `shared/bottom-drawer.css` — `body.mtray-tucked .bdr { --dp-right: 48px }`.

## Session change log
- **2026-09-24** — (Cris) page load stays folded; only a call ringing NOW (or a new FB message) opens the tray; backfilled calls join quietly. FB threads past the 24 h window don't count toward the badge / "N waiting" ([[messenger-tray]] §2). Staging.
- **2026-09-24** — driven on test.* at `d5ddc37` (ZZ Test Owner, sandbox): served files byte-identical; `#callCardStack` gone; load → strip (this browser had tucked before, nothing new since — the existing FB rule). **Single fake ring** (`cdHandleTestCall`, JOSE RAMIREZ's number) → tray opened from the strip, board pushed 340 px, glance: "Returning · JOSE RAMIREZ · (813) 590-9459 · Chevrolet C1500 +1 · In shop now RO #6009 · 1993 Chevrolet c1500 · Ready for pickup · Heads up None", strip 📞 1 pulsing, FB threads continue "Needs handling". **3 in a row** → newest pinned, the other three rows "ringing", strip 4. Opened one → Call back · Coming in · Done (coming), Attach / Start RO / Not a customer (coming), "Recording — none (test call)"; **Close un-noted → refused** with the message, focus to the note; typed a note (real keys) → Close worked. Rings fast-forwarded past 2 min → no-note rows on top ("no note yet"), the noted one last, pulse off. **Real save:** a fake CTM ring posted to test.*'s own webhook created sandbox `calls` row 297; it did NOT pop live (sandbox realtime gap — Known gaps) — the backfill brought it in (pinned glance "New caller · TEST TRAYCALL"); Answered → note (real keys) + Call back + Tomorrow → row 297: note, `next_step quoted_callback`, `due_at` Fri Sep 25 all-day, `noted_by_name` ZZ Test Owner, `resolved_at` null; recording "arrives a few minutes after the call ends"; Close worked. **Layout:** 1440 open → drawer 232–1100 / tray 1100–1440; 1440 strip → drawer 232–1392 / strip 1392–1440, board padded 48; 1100 open → 232–760 / 760–1100; 1100 strip → 232–1052 / 1052–1100 — no overlap anywhere. Left on the sandbox: row 297 as a TEST callback on the Desk (Fri Sep 25).
- **2026-09-24** — created with slice 1 (staging): cards moved into the Inbox tray; default folded strip pushes the board; pinned caller-ID glance while ringing; "Needs handling" with no-note calls on top; the card opens in the tray with its recording; next step Call back · Coming in · Done (coming); un-noted calls can't be closed; backfill = today's untouched calls. No DB change.
