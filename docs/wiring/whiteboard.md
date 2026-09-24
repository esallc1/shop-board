# How the Whiteboard is wired
> Doc: `/docs/wiring/whiteboard.md`
> Last updated: 2026-09-24 — **§6a (slice 6, staging): 📌 on a Desk pad sticky moves it here as a Don't forget line**. Earlier the same day: slice 5 + the closed-RO rule, slices 1–4 and the office-whiteboard look.
> Verified vs commit `0accb27` (slice 6 — 📌 — driven on test.* 2026-09-24). Earlier checks: see the change log.
> Status: 🟢 **LIVE on prod** — slices 1 + 2 since `968d376`; the look + slices 3 + 4 since `8014f95`; slice 5 (Waiting on parts + the closed-RO rule) since `bc22bc8` (2026-09-24). No migration for slice 5. 🟡 slice 6 (📌 from the Desk pad) on **staging only**.
> Related: [[desk-pad]] (the other tab of the same drawer; §2 there = the drawer frame),
> [[ro-checkin-tech]] §8 (the close path that sets `status = 'closed'`), [[messenger-tray]] (shares the right edge),
> [[call-window-desk]] (the Desk tab — **untouched**; the Whiteboard only holds what the Desk doesn't).

## 0. In one line
The shop's shared whiteboard at the bottom of the advisor board — the second tab of the bottom drawer
("📋 Whiteboard", key **W**) — showing the ROs that are ready and need a pickup call (with who called
them, and when), a "Waiting on parts" list (optionally tied to an RO) with "Arrived ✓", and a
"Don't forget" list anyone in the office can write on and erase.

## 1. Where it is on the page
- A **panel** of the bottom drawer (`shared/bottom-drawer.js`, described in [[desk-pad]] §2). The drawer
  has two tabs: **📝 Desk pad** (N) and **📋 Whiteboard** (W). One shows at a time; the other tab
  switches; the open one, **Hide ▾**, or **Esc** (focus inside the drawer) hides it. Same push-up,
  one-row-to-45 % height and Facebook-tray right edge as the Desk pad.
- Mounted by **one call**, `mountFrontDeskDrawer({ db })` (`shared/front-desk-drawer.js`), in a module
  before `</body>` of `advisor-board.html`. **Advisor board only** (Cris, 2026-09-24). Putting it on the
  manager / owner / bookkeeping boards later = their three stylesheet links + that call — no per-board
  copy of the code (test-locked: the other three boards don't load it today).
- The closed tab shows a count: the number of ROs ready for pickup.
- **W** toggles it only when nobody is typing, with no Ctrl/⌘/Alt and not a held-down repeat —
  `isBoardToggleKey` in `shared/desk-pad-logic.js`, next to N's `isPadToggleKey`, same guards.

## 2. What it looks like — the office whiteboard (approved mockup)
Drawn like the real board on the office wall — the Front Desk mockup Cris approved 2026-09-16
("Front Office Whiteboard"), restyled to match it on 2026-09-24 (Cris: "right now it looks like
another notepad"):
- **Aluminum frame** (grey gradient, rounded, shadow) around a **glossy white board**, on a light
  wall background; a **marker tray** along the bottom edge with three markers (black, blue, red).
- **Header:** "FRONT OFFICE" in marker, a thick black rule under it, today's date top-right in red
  marker — `boardDate()` = shop time, e.g. "THU 9/24".
- **Zones are written on the board — no boxes, no cards.** Titles in marker, UPPERCASE, underlined,
  each its own colour: **WAITING ON PARTS** (red) · **READY → CALL FOR PICKUP** (blue) ·
  **DON'T FORGET** (red). They sit side by side and wrap on a narrow window (flex; the Ready zone gets
  the most room). An empty Ready zone shows faint marker text ("nobody waiting on a call"); the two
  hand-written zones always show their "+ write on board" link.
- **Lines are handwriting** (not app cards), each with the mockup's small chip in front:
  **⚡ auto** (fills itself — the Ready lines) or **✎ hand** (written by a person — Waiting on parts, Don't forget).
  A sticky pinned from the Desk pad will show as a yellow sticky on the board (`li.stk`, slice 6).
- **Fonts are self-hosted** in `shared/fonts/` — no font CDN: **Permanent Marker** (titles; Apache 2.0)
  and **Kalam** 400/700 (lines; SIL OFL 1.1), latin subset, `font-display: swap`, with system
  handwriting fonts as fallback. Licence texts sit next to the files. Test-locked: no
  googleapis/gstatic/`http` in `whiteboard.css`.

## 3. Ready → call for pickup
- **Which ROs:** every `repair_orders` row with **`status = 'invoice'`** — the RO Board's "Ready for
  pickup" column (`STAGES` in `advisor-board.html`). The floor's pickup zone (`shopboard_pickup`) is
  **not** used (Cris, 2026-09-24).
- **Leaves on its own:** the list is worked out fresh on every read, so an RO disappears when its status
  becomes `'closed'` (the Off lot / close path) and **comes back** if it is reopened to `'invoice'`.
  Status only — **never `closed_at`**, which is kept when an RO is reopened.
- **Each line:** ⚡ auto, then `#<po or ro_number>` (same as the RO Board card; a different `ro_number`
  shows small after it), the customer's name, " — " and the vehicle (year make model), in handwriting.
  Oldest RO first (`created_at`).
- **Click a line** → the RO opens the normal way: the RO Board sidebar tab, then `window.cdOpenRo(id)` —
  the same door global search uses. The drawer stays open.

### 3a. "Called ✓" (slice 3)
- Every Ready line has a small marker-style **Called ✓** button. Tap → the line reads
  **"✓ called · <name> · <time>"** in green marker (and the RO text greys a little), with a small
  **undo** for a mis-tap. Time = shop time: "2:14 PM" today, "Tue 2:14 PM" this week, "9/17" older
  (`whenText` / `stamp`).
- One stamp per RO (`whiteboard_pickup_calls`, §7). **The line still leaves when the RO closes** (the
  status filter, §3). The stamp row stays, so **if the RO comes back to `'invoice'` later, the old
  stamp shows again**. undo = the stamp goes back to empty (the row is kept; nothing is deleted).
- Only an RO whose status is `'invoice'` can be stamped (the endpoint answers 409 "That RO isn't ready
  for pickup any more." otherwise — shown under the zone).

## 4. Reading — read-only queries, with the viewer's own session
All with the board's own signed-in Supabase client (passed in as `db`):
1. `repair_orders.select(READY_SELECT).eq('status', 'invoice').order('created_at')`, where
   `READY_SELECT = 'id, ro_number, po, status, created_at, customers(name), vehicles(year, make, model)'`.
   Named columns only — no `*`, no `book_hours`, no `closed_at`. `readyLines()` **drops anything that
   isn't `'invoice'`** a second time.
2. `whiteboard_pickup_calls.select('ro_id, called_at, called_by, called_by_name').in('ro_id', <the Ready ROs>)`.
3. `whiteboard_items.select(ITEM_SELECT + ', ' + ITEM_RO_EMBED).in('kind', ['note', 'parts'])` where
   `cleared_at` is null **or** in the last 7 days (`.or('cleared_at.is.null,cleared_at.gte.<7 days ago>')`),
   oldest first, max 400. `ITEM_RO_EMBED = 'ro:repair_orders(id, ro_number, po, status, updated_at,
   customers(name), vehicles(year, make, model))'` — a parts line's RO comes with it (over the `ro_id`
   foreign key); its `status` decides whether the line is on the board (§6b), `updated_at` only dates
   the 7-day window. **Never `closed_at`** — see §6b. `noteLists(rows, now, kind)` splits each kind: on the board and recently cleared
   (Don't forget: `erased`; Waiting on parts: `erased`, `arrived`, and — derived — its RO closed).
4. **Only when the parts box is opened:** `repair_orders.select(PICK_SELECT).neq('status', 'closed')
   .order('created_at', desc).limit(400)` — the open ROs for the picker (`pickOptions`, `matchRos`).
- 2, 3 and 4's items are **staff-only** tables (RLS `is_staff()`, §7): read only when there is a signed-in
  session; without one the hand-written zones and the Called buttons don't show.
- **Never writes through the client, never re-saves an RO.** The Whiteboard files contain no `.update(` /
  `.insert(` / `.upsert(` / `.delete(` / `.rpc(`, no direct `fetch(`, and never touch `openRo` /
  `currentRo` / `updateBookHoursAuto`; the only way out is `cdAuthFetch(db, '/api/whiteboard', …)` (§8)
  and it never sends who/when (test-locked in `shared/whiteboard-logic.test.js`). Clicking a line (or a
  parts line's RO) is an ordinary RO open, with the ordinary RO-open behaviour.
- A failed read keeps the last good lines on screen with "couldn't load the list — trying again".

## 5. Live updates
- One realtime channel `advisor-board-whiteboard-live` on **`repair_orders`, `whiteboard_items` and
  `whiteboard_pickup_calls`** — any change → one re-read of §4, debounced 400 ms.
- **`db.realtime.setAuth(<the viewer's access token>)` before subscribing** (same as the Messenger tray):
  the whiteboard tables are staff-only, so the socket must run as the viewer or RLS hides the changes.
- All three tables are in `supabase_realtime`: `repair_orders` on prod since July and on the sandbox
  since 2026-09-24 (`migrations/20260924_sandbox_repair_orders_realtime.sql`, [[staging-db]]); the two
  whiteboard tables by their own migration (§7).
- The person who made a change sees it at once (the endpoint's returned row is folded in — `upsertRow`),
  then a quick re-read; everyone else gets it by realtime.
- A **catch-up re-read every 60 s**, one when the browser tab becomes visible again, and one each time
  the Whiteboard tab is shown. The list loads at page load, so the closed tab's count is live.
- Measured on test.*: `repair_orders` → Whiteboard in 0.7 s / out 1.1 s (2026-09-24).

## 6. Don't forget (slice 4)
- **+ write on board** → a one-line box in handwriting under the list (up to 500 characters). **Enter**
  or "save" saves and **the box closes** (Cris, 2026-09-24) — "+ write on board" again for the next
  line. If the save fails, the box stays open with the text and the reason shows under it. **Esc** or
  "cancel" closes it without saving (Esc here closes only the box, not the drawer — the drawer skips an
  Esc a panel already handled). Empty = nothing saved.
- Each line: ✎ hand, the text, **"— <name> · <time>"** (who wrote it, when), and a small **×**.
- **Anyone in the office can erase any line** (×, no confirm — Undo is right there). An erased line goes
  to **"recently erased (n) ▾"** under the zone (the last 7 days, newest first), shown struck through
  with "erased by <name> · <time>" and an **Undo** that puts it back on the board exactly as it was
  (same writer, same time).
- Two people erasing the same line: the second gets "Someone already took that line off the board."
- N / W typed into the box are letters, never the drawer shortcuts (the typing guard).

### 6a. 📌 from the Desk pad (slice 6)
- Each Desk pad sticky has a **📌** ([[desk-pad]] §3). Tap → the sticky's (trimmed) text is posted here
  as a **Don't forget** line — `pin(text)` on this panel = `POST /api/whiteboard { action: 'add', kind:
  'note', text }`, so who + when are stamped by the server exactly like "+ write on board".
- **A move, not a copy:** the pad removes the sticky **only when `pin` resolved `{ ok: true }`** (the
  server stored it). Any failure resolves `{ ok: false, error }` in plain words (`actionError` — e.g. a
  401 → "Your CrisData sign-in isn't active on this page…") and the sticky stays. `pin` never throws.
- Wiring: `mountFrontDeskDrawer` builds both panels and hands the pad `pinToBoard(text)` → this panel's
  `pin` — the pad itself never touches the network. Before the Whiteboard exists it answers "The
  whiteboard isn't ready yet — try again in a moment."
- The new line is **highlighted** (a short yellow fade, `li.is-fresh`, 4 s) the first time the
  Whiteboard is shown after the pin (right away if it's already showing); reduced-motion → a plain tint.
- It's an ordinary Don't forget line afterwards (erase / Undo as usual). The mockup's permanent
  "from desk pad" yellow-sticky look is **not** kept after a reload — the table has no "where it came
  from" column (see Known gaps).

## 6b. Waiting on parts (slice 5)
- **+ write on board** → a small form: first an **optional RO** search ("RO #, customer or vehicle"),
  then the **note** ("part · vendor · ETA…", ≤ 500), save / cancel.
  - The search lists **open ROs only** (not `closed`), newest first, up to 8: digits match the RO / PO
    number, words match customer + vehicle (every word must match). ↑/↓ move, **Enter picks** (it never
    submits the form), a click picks. The picked RO shows as a yellow chip with × to drop it.
  - **No RO = free text** (e.g. "shop order: 10 qts ATF").
  - Enter in the note (or save) saves and **the box closes**; Esc / cancel close without saving. With an
    RO picked but no note: "Write what part it's waiting on." (nothing saved).
- A line reads **✎ hand · "#6089 · Ford F-250 · DALE SMITH — torque converter · Transtar · ETA Fri
  — <name> · <time>"** (`roLabel` = number · make model · customer; who/when stamped by the server).
  The **RO part is a link** that opens the RO the normal way (same door as the Ready lines).
- **Arrived ✓** (green) takes it off with `cleared_reason = 'arrived'`; **×** erases it. Both land in
  **"recently cleared (n) ▾"** (7 days, newest first), each reading **"arrived · <name> · <time>"** or
  **"erased · <name> · <time>"** (`clearedLabel`), with **Undo**.
- The endpoint refuses an RO that doesn't exist (404) or is **closed** (409 "That RO is closed — pick an
  open one, or leave the RO empty.") — shown under the zone, the box stays open with the text.
- **A line whose RO closes comes off the board by itself** (Cris, 2026-09-24) — **derived at read time,
  nothing is written** (no `cleared_*`, no new `cleared_reason`; same idea as the Ready list):
  `noteLists` treats a not-cleared parts line whose embedded RO has `status = 'closed'` as off the board
  and lists it under "recently cleared" as **"RO closed"** — **no Undo** (there's nothing to undo:
  **reopening the RO brings the line back by itself**, because its status is no longer `closed`). It
  stays in "recently cleared" for 7 days from the RO's **`updated_at`** (= the close, unless the closed
  RO was edited since).
  - **Why no time, and why not `closed_at`:** the database has no true "closed at". `repair_orders.closed_at`
    is the **set-once pay stamp** — the FIRST time an RO reached `invoice` **or** `closed`, never moved
    (`migrations/20260807_ro_closed_at.sql`) — so it's usually the invoice time and would show the wrong
    time (on test.* it said 5:17 AM for a 6:4x close). `updated_at` moves on any later edit. An exact
    close time would need a new stamp in the DB — open question below. Lines with no RO are unaffected; a line a person already cleared keeps its
  own "arrived / erased" reason. Live: an RO status change arrives on the `repair_orders` realtime (§5).

## 7. Storage — `whiteboard_items` + `whiteboard_pickup_calls`
Migration `migrations/20260924_whiteboard_{SANDBOX,PROD}.sql` (self-guarding on `app_env`, one
transaction, one-query PASS/FAIL verify block; posture test-locked by `shared/whiteboard-migration.test.js`).
**Applied by Cris 2026-09-24 — SANDBOX then PROD, 8/8 PASS on each.**
- **`whiteboard_items`** — `id`, `kind` (`parts` | `note`), `text` (1–500 after trim, CHECK), `ro_id`
  (optional → `repair_orders`), `created_by` (→ employees), `created_by_name`, `created_at`,
  `cleared_at`, `cleared_by`, `cleared_by_name`, `cleared_reason` (`arrived` | `erased`). CHECKs:
  `cleared_at` and `cleared_reason` are set together; `arrived` only on a `parts` line. **Never deleted** —
  erase / Arrived ✓ set `cleared_*`, Undo clears them.
- **`whiteboard_pickup_calls`** — `ro_id` (PK → `repair_orders`), `called_at`, `called_by`,
  `called_by_name`, `updated_at`. One row per RO; undo sets the stamp to null and keeps the row.
- **Who can do what** (the social_* pattern): `anon` nothing; `authenticated` **SELECT only, and only
  when `public.is_staff()`** (a KiKi login is `authenticated` too — not enough); `service_role` everything.
  No insert/update/delete policies — the browser never writes these tables. Both in `supabase_realtime`.

## 8. The endpoint — `api/whiteboard.js`
- **POST only.** `requireUser(req)` **first**: a live Supabase session that maps to exactly one ACTIVE
  employee, else a flat **401** and nothing is read (same gate as `api/messenger.js`). Then `parseBody`
  (400 on anything malformed), then the service-role key.
- Actions — each writes **only its own columns**:
  | action | body | writes |
  |---|---|---|
  | `add` | `kind` note or parts, `text` (≤ 500), `ro_id`? | a new row: kind, text, ro_id, created_by, created_by_name (RO must exist → 404, and not be `closed` → 409) |
  | `clear` | `id`, `reason` erased or arrived | `cleared_at/_by/_by_name/_reason` — only if not cleared yet (409); `arrived` only on parts (400) |
  | `undo` | `id` | the four `cleared_*` back to null |
  | `called` | `ro_id` | upsert on `ro_id`: `called_at/_by/_by_name`, `updated_at` — only for status `'invoice'` (409) |
  | `uncalled` | `ro_id` | `called_*` back to null (row kept) |
- **Who + when are always stamped on the server** (the employee from `requireUser`, the server clock) —
  anything the browser sends for them is ignored. `repair_orders` is only READ. Nothing is ever DELETEd.
- Tested by `api/whiteboard.test.js` (401 × no token / junk / KiKi login / inactive employee, 405, 400s,
  server-side stamps, own columns only, the 404/409 rules, never writes `repair_orders`, never DELETE).

## Known gaps & open questions (as of 2026-09-24)
- **"RO closed" carries no time** — there's no true close time in the DB (§6b). Showing one would need a
  DB change (e.g. a `repair_orders.last_closed_at` stamped by a trigger every time status becomes
  `closed`) — Cris's call; not built.
- Slice 7 not built: the drawer on the manager / owner / bookkeeping boards.
- A pinned sticky becomes a plain Don't forget line — it's highlighted once, but the mockup's lasting
  yellow "from desk pad" sticky look would need a "source" column on `whiteboard_items` (a migration) —
  not built; Cris's call. (`li.stk` CSS is there, unused.)
- Any change to the three tables re-reads the board (three small queries, debounced) — fine at this
  shop's volume; revisit only if it isn't.

## Where it lives in the code
- `shared/whiteboard.js` — the panel: `createWhiteboardPanel(ctx, { db })` (the reads, realtime + `setAuth`, catch-up, click → `cdOpenRo`, the actions via `cdAuthFetch` → `/api/whiteboard`, and `pin(text)` for the Desk pad's 📌).
- `shared/whiteboard-logic.js` — `READY_STATUS`, `READY_SELECT`, `readyLines`, `vehicleText`, `boardDate`, `CALL_SELECT`, `ITEM_SELECT`, `ITEM_RO_EMBED`, `PICK_SELECT`, `RECENT_DAYS`, `NOTE_MAX`, `whenText`, `stamp`, `callsByRo`, `noteLists`, `clearedLabel`, `roLabel`, `pickOptions`, `matchRos`, `upsertRow`, `actionError`. Tested by `shared/whiteboard-logic.test.js`.
- `api/whiteboard.js` (+ `api/whiteboard.test.js`) — every write (§8); uses `api/_lib/require-user.js`.
- `migrations/20260924_whiteboard_{SANDBOX,PROD}.sql` (+ `shared/whiteboard-migration.test.js`) — the two tables (§7).
- `shared/whiteboard.css` — the board look (frame, board, marker titles, handwriting lines, chips, Called ✓, write box, recently erased, tray) + the `@font-face` rules.
- `shared/fonts/` — `permanent-marker-400.woff2`, `kalam-400.woff2`, `kalam-700.woff2` + `KALAM-OFL.txt`, `PERMANENT-MARKER-LICENSE.txt`.
- `shared/front-desk-drawer.js` — `mountFrontDeskDrawer({ db })`: the drawer with both panels, and the pad's `pinToBoard` → this panel's `pin`.
- `shared/bottom-drawer.js` + `shared/bottom-drawer.css` — the drawer frame ([[desk-pad]] §2); skips an Esc a panel already handled.
- `shared/desk-pad-logic.js` — `isBoardToggleKey` (W).
- `advisor-board.html` — the three stylesheet links and the mount module before `</body>` (`cdAuthFetch` is already loaded there).

## Session change log
- **2026-09-24** — slice 6 driven on test.* at `0accb27` (sandbox, ZZ Test Owner): served files byte-identical (8). N → + New note → 📌 disabled while empty, enabled after typing (real keys) "Pin test: order 2 cases Mercon LV"; 📌 → sticky gone from the pad and from localStorage; W → the line under Don't forget "— ZZ Test Owner · 12:46 PM", highlighted (`is-fresh`). Failures (the page's `cdAuthFetch` swapped for the test, then restored): a 401 → sticky stays, "Your CrisData sign-in isn't active on this page — log out and sign in again."; a thrown fetch (offline) → stays, "Couldn't pin it to the whiteboard — it's still here. Try again."; 612 characters → stays, "Too long for the whiteboard (612 / 500 characters) — shorten it first." — none reached the board. Cleaned up: pad torn off, the pinned test line erased (soft).
- **2026-09-24** — slice 6 on staging: 📌 on each Desk pad sticky → `pin(text)` → a Don't forget line (server-stamped); the sticky leaves the pad only on success, stays with an error otherwise; new line highlighted once. No migration.
- **2026-09-24** — **slice 5 shipped to prod** as `bc22bc8` (fast-forward `95131a4..bc22bc8`, Cris's OK after testing on test.* as ZZ Test Advisor: RO search → #6033, note with his name 7:36 AM, box closed, Arrived ✓ → "recently cleared · arrived · ZZ Test Advisor" + Undo). www / board. / apex `/api/version` = `bc22bc8` (one www read flipped back to the old SHA mid-switch, then steady); `whiteboard.js` / `.css` / `-logic.js` / this doc byte-identical on all three; CLAUDE.md 404; `POST /api/whiteboard` no token → 401 (www, board.). Prod pane, read-only (no RO opened, nothing written): W opened the board — WAITING ON PARTS zone with its RO picker loaded, no "coming next", Ready = the 5 real ROs; the pane has no prod sign-in, so "+ write on board" stayed hidden (by design) — not eyeballed signed-in on prod.
- **2026-09-24** — closed-RO rule driven on test.* at `157ebd6` (sandbox, RO #6033 with the "torque converter · Transtar" line): status → `closed` → line off the board in 0.9 s, "recently cleared" shows "#6033 · Toyota Rav4 · IAN GEQUELIN — torque converter · Transtar · ETA Fri — RO closed" with no Undo; → `ro` → back on the board in 1.1 s, gone from recently cleared. The `whiteboard_items` row was never written (`cleared_at` / `cleared_reason` still null). #6033 left at `ro`.
- **2026-09-24** — Cris's call on the open question: a parts line whose RO is closed now leaves the board automatically — derived from the RO's `status` at read time (`noteLists`, `auto: 'ro_closed'`), shown under "recently cleared" as "RO closed" without Undo, 7 days from the RO's `updated_at`; reopening the RO brings it back. No migration, no new `cleared_reason`, no write. Known gap removed. First cut dated it with `closed_at` — caught on test.* (showed 5:17 AM for a 6:4x close: `closed_at` is the set-once pay stamp) and changed the same day to no time + `updated_at` window; exact time left as an open question.
- **2026-09-24** — slice 5 driven on test.* at `c596275` (sandbox, two tabs, ZZ Test Owner): served files byte-identical. Typed "6033" in the RO search → "#6033 · Toyota Rav4 · IAN GEQUELIN"; Enter picked it (form not submitted), note "torque converter · Transtar · ETA Fri" + Enter → line in tab 1 in 1.0 s, tab 2 ~1.9 s, RO part a link; box closed. Enter in the empty search → jumped to the note; "shop order: 10 qts ATF" (no RO) → tab 2 in 1.5 s. Arrived ✓ in tab 2 → gone in tab 1 1.3 s, "recently cleared (1)" = "arrived · ZZ Test Owner · 6:31 AM"; Undo in tab 1 → back in tab 2 1.3 s. × → "erased · ZZ Test Owner · 6:31 AM", Undo → back. Clicking the RO part → RO Board + RO #6033 open. Both test lines left on the sandbox board for Cris to look at.
- **2026-09-24** — slice 5 on staging: Waiting on parts — optional RO picker (open ROs, number / customer / vehicle), note, who/when, RO part opens the RO, Arrived ✓ + ×, "recently cleared" (arrived / erased) + Undo, box closes after save. Endpoint: `add` with an `ro_id` now refuses a closed RO (409). The two hand-written zones share one code path (`Z.parts` / `Z.note`). No migration.
- **2026-09-24** — **shipped to prod** as `8014f95` (fast-forward `b713d50..8014f95`, Cris's OK; PROD migration applied first, 8/8 PASS). www / board. / apex `/api/version` = `8014f95`; the 11 changed served files byte-identical on all three; migrations + CLAUDE.md 404; `POST /api/whiteboard` without a token → 401 (www, board.; the apex 308-redirects to www as always); anon REST read of `whiteboard_items` / `whiteboard_pickup_calls` on prod → 42501. Prod pane, read-only (no RO opened, nothing written): W opened the board — look + self-hosted fonts loaded, THU 9/24, live channel joined, Ready = #6013 SEAN DOHERTY, #6065 TODD FIRMSTONE, #6078 INTELIGENT SOLUTIONS, #6092 TONY KRUG, #6098 TC AUTOMOTIVE. That pane has no prod sign-in, so the hand-written half + Called ✓ stayed hidden (by design) — not eyeballed signed-in on prod.
- **2026-09-24** — two-person check with Cris on test.*: his line as **ZZ Test Advisor** (Chrome) — "test from advisor - order ATF · ZZ Test Advisor · 6:12 AM" — appeared live on the ZZ Test Owner tab (loaded 6:06, no reload); from ZZ Test Owner at 6:14: Called ✓ on #6026, a new line, and his line erased, for Cris to confirm on his side. Change (Cris): the write box now **closes after each save** (stays open with the text only when a save fails).
- **2026-09-24** — slices 3 + 4 driven on test.* at `a489f36` (sandbox; two tabs, each its own page + realtime socket, both signed in as ZZ Test Owner — Chrome had no test.* session and Claude doesn't type passwords, so not two different people): served files byte-identical; `/api/whiteboard` GET 405, POST no token / junk token 401; anon REST read of `whiteboard_items` → 42501. Typed a note + Enter in tab 1 → shown there 0.7 s, in tab 2 ~1.9 s, stamped "ZZ Test Owner · 6:07 AM" by the server; Called ✓ in tab 2 → stamp in tab 1 in 1.8 s; Esc in the write box closed only the box, a 2nd Esc hid the drawer; erase in tab 2 → gone in tab 1 1.6 s, "recently erased (1)" with who; Undo in tab 1 → back in tab 2 1.3 s, original writer + time; RO #6009 `invoice`→`ro`→`invoice` (sandbox) → left 1.1 s, back 0.9 s **with its old stamp**; undo call in tab 1 → gone in tab 2 1.7 s. Left: #6009 at `invoice`, its call row stamp-empty, the test note erased (soft).
- **2026-09-24** — slices 3 + 4 on staging: `whiteboard_items` + `whiteboard_pickup_calls` (SANDBOX applied by Cris, 8/8 PASS; PROD not run), `api/whiteboard.js` (add / clear / undo / called / uncalled, `requireUser` first, server-side stamps), "Called ✓" + undo on Ready lines, Don't forget (+ write on board, who/when, erase, recently erased + Undo), realtime on all three tables after `setAuth`. The drawer now skips an Esc a panel already handled.
- **2026-09-24** — restyled to the approved Front Office whiteboard mockup (Cris: "looks like another notepad"): aluminum frame, glossy board, FRONT OFFICE + red date, marker zone titles (parts red · ready blue · don't forget red), handwriting lines with ⚡ auto chips, marker tray; grey dashed "Coming next" boxes removed (faint marker text instead); fonts self-hosted in `shared/fonts` (Permanent Marker, Kalam). Checked locally at 1100 and 800 px. Staging only.
- **2026-09-24** — **shipped to prod** as `968d376` (fast-forward `7dbaff0..968d376`, Cris's OK). www / board. / apex `/api/version` = `968d376`; the 14 changed served files byte-identical on all three; migration record + CLAUDE.md 404. Prod read-only (no RO opened, no status moved): W opened the Whiteboard (324 px, page pushed 324), N switched to the pad, Esc hid it (scroll 0); "Ready → call for pickup" = #6013 SEAN DOHERTY, #6065 TODD FIRMSTONE, #6078 INTELIGENT SOLUTIONS, #6092 TONY KRUG, #6098 TC AUTOMOTIVE — matches a direct status='invoice' query; realtime channel joined.
- **2026-09-24** — realtime proven on test.* after Cris added `repair_orders` to the sandbox's `supabase_realtime` (prod already had it): Whiteboard in 0.7 s / out 1.1 s, RO Board 0.4 s / 0.7 s (RO #6033 `ro`→`invoice`→`ro`, left at `ro`). §5 + Known gaps rewritten.
- **2026-09-24** — driven on test.* at `d158b6a` (ZZ Test Owner, sandbox DB): served files byte-identical (13); 1100 px + tray open → drawer 232→760, 324 px (45 % cap, zones wrap), page pushed 324; tray tucked → 232→1100, 228 px, page pushed 228; real keys: N switched to the pad, Esc hid it (scroll 0, padding 44), W opened, W again hid, **w typed in the search box did not open it**; 800 px → overlay (no push), tray open covers the right of the drawer (z 2900, same as before); 2 real invoice ROs (#6009, #6026); click #6009 → RO Board + that RO open, drawer stays. **RO #6033 round trip** (`ro` → `invoice` → `closed` → `invoice` → `ro`): appeared, disappeared on close, came back on reopen, left on restore — each via the 60 s catch-up, because realtime delivered no `repair_orders` events (see §5). Side effect: closing #6033 on the sandbox stamped its `closed_at` (kept on reopen, by design).
- **2026-09-24** — created (slices 1 + 2, staging only): the Desk pad became the bottom drawer's first tab and the Whiteboard its second (W); "Ready → call for pickup" = status `'invoice'`, read-only, live; Waiting on parts / Don't forget shown as "Coming next".
