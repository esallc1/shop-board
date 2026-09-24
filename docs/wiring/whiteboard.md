# How the Whiteboard is wired
> Doc: `/docs/wiring/whiteboard.md`
> Last updated: 2026-09-24 — **§2 restyled to the approved whiteboard mockup** (staging). Created the same day with slices 1 + 2.
> Verified vs commit `968d376` (slices 1 + 2; driven on test.* and read-only on prod 2026-09-24).
> Status: 🟢 slices 1 + 2 **LIVE on prod** since `968d376`; 🟡 the whiteboard restyle is on **staging only** (test.*) until Cris's OK.
> Related: [[desk-pad]] (the other tab of the same drawer; §2 there = the drawer frame),
> [[ro-checkin-tech]] §8 (the close path that sets `status = 'closed'`), [[messenger-tray]] (shares the right edge),
> [[call-window-desk]] (the Desk tab — **untouched**; the Whiteboard only holds what the Desk doesn't).

## 0. In one line
The shop's shared whiteboard at the bottom of the advisor board — the second tab of the bottom drawer
("📋 Whiteboard", key **W**) — showing the ROs that are ready and need a pickup call; the parts and
"don't forget" zones come next.

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
  the most room). An empty zone shows only its title and faint marker text ("coming next" until slices
  4/5 ship; "nobody waiting on a call" when the Ready list is empty).
- **Lines are handwriting** (not app cards), each with the mockup's small chip in front:
  **⚡ auto** (fills itself — the Ready lines) or **✎ hand** (written by a person — slices 4/5).
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
- "Called ✓" (who + when) is **not** in this slice — it needs the new table + endpoint (slice 3).

## 4. Reading — read-only, one query
- **One query**, with the board's own signed-in Supabase client (passed in as `db`):
  `repair_orders.select(READY_SELECT).eq('status', 'invoice').order('created_at')`, where
  `READY_SELECT = 'id, ro_number, po, status, created_at, customers(name), vehicles(year, make, model)'`.
  Named columns only — no `*`, no `book_hours`, no `closed_at`.
- `readyLines()` shapes the rows and **drops anything that isn't `'invoice'`** a second time.
- **Never writes, never re-saves an RO.** The Whiteboard files contain no `.update(` / `.insert(` /
  `.upsert(` / `.delete(` / `.rpc(`, no endpoint call, and never touch `openRo` / `currentRo` /
  `updateBookHoursAuto` — so drawing the board can't trip the "opening an RO re-saves book_hours" trap
  (test-locked in `shared/whiteboard-logic.test.js`). Clicking a line is an ordinary RO open, with the
  ordinary RO-open behaviour.
- A failed read keeps the last good lines on screen with "Couldn't load the list — trying again shortly."

## 5. Live updates
- A realtime channel `advisor-board-whiteboard-live` on `repair_orders` (any change → one re-read,
  debounced 400 ms) — the same table the board's RO list and Desk listen to. It only fires because
  `repair_orders` is in the project's `supabase_realtime` publication (prod since July; sandbox since
  2026-09-24).
- A **catch-up re-read every 60 s**, one when the browser tab becomes visible again, and one each time
  the Whiteboard tab is shown.
- The list loads at page load (not only when the tab is opened), so the closed tab's count is live.
- **Proven live on test.*** (2026-09-24, after the sandbox fix): an RO moved to `invoice` appeared on
  the Whiteboard in **0.7 s** and left in **1.1 s** when moved back; the RO Board's Ready for pickup
  column followed in 0.4 s / 0.7 s. Before the fix the sandbox's `supabase_realtime` publication lacked
  `repair_orders` (prod has had it since July), so test.* only moved on the 60 s catch-up — Cris added it
  on the sandbox (`migrations/20260924_sandbox_repair_orders_realtime.sql`, SANDBOX ONLY; [[staging-db]]).

## Known gaps & open questions (as of 2026-09-24)
- Slices 3–7 not built: the `whiteboard_items` / `whiteboard_pickup_calls` tables + `api/whiteboard.js`
  (staff-only, `requireUser` + service role, like `api/messenger.js`), "Called ✓", Don't forget,
  Waiting on parts, "📌 Whiteboard" on stickies, other boards.
- Any `repair_orders` change anywhere re-reads the list (one small query, debounced) — fine at this
  shop's volume; revisit only if it isn't.

## Where it lives in the code
- `shared/whiteboard.js` — the panel: `createWhiteboardPanel(ctx, { db })` (the query, realtime, catch-up, click → `cdOpenRo`).
- `shared/whiteboard-logic.js` — `READY_STATUS`, `READY_SELECT`, `readyLines`, `vehicleText`, `boardDate`. Tested by `shared/whiteboard-logic.test.js`.
- `shared/whiteboard.css` — the board look (frame, board, marker titles, handwriting lines, chips, tray) + the `@font-face` rules.
- `shared/fonts/` — `permanent-marker-400.woff2`, `kalam-400.woff2`, `kalam-700.woff2` + `KALAM-OFL.txt`, `PERMANENT-MARKER-LICENSE.txt`.
- `shared/front-desk-drawer.js` — `mountFrontDeskDrawer({ db })`: the drawer with both panels.
- `shared/bottom-drawer.js` + `shared/bottom-drawer.css` — the drawer frame ([[desk-pad]] §2).
- `shared/desk-pad-logic.js` — `isBoardToggleKey` (W).
- `advisor-board.html` — the three stylesheet links and the mount module before `</body>`.

## Session change log
- **2026-09-24** — restyled to the approved Front Office whiteboard mockup (Cris: "looks like another notepad"): aluminum frame, glossy board, FRONT OFFICE + red date, marker zone titles (parts red · ready blue · don't forget red), handwriting lines with ⚡ auto chips, marker tray; grey dashed "Coming next" boxes removed (faint marker text instead); fonts self-hosted in `shared/fonts` (Permanent Marker, Kalam). Checked locally at 1100 and 800 px. Staging only.
- **2026-09-24** — **shipped to prod** as `968d376` (fast-forward `7dbaff0..968d376`, Cris's OK). www / board. / apex `/api/version` = `968d376`; the 14 changed served files byte-identical on all three; migration record + CLAUDE.md 404. Prod read-only (no RO opened, no status moved): W opened the Whiteboard (324 px, page pushed 324), N switched to the pad, Esc hid it (scroll 0); "Ready → call for pickup" = #6013 SEAN DOHERTY, #6065 TODD FIRMSTONE, #6078 INTELIGENT SOLUTIONS, #6092 TONY KRUG, #6098 TC AUTOMOTIVE — matches a direct status='invoice' query; realtime channel joined.
- **2026-09-24** — realtime proven on test.* after Cris added `repair_orders` to the sandbox's `supabase_realtime` (prod already had it): Whiteboard in 0.7 s / out 1.1 s, RO Board 0.4 s / 0.7 s (RO #6033 `ro`→`invoice`→`ro`, left at `ro`). §5 + Known gaps rewritten.
- **2026-09-24** — driven on test.* at `d158b6a` (ZZ Test Owner, sandbox DB): served files byte-identical (13); 1100 px + tray open → drawer 232→760, 324 px (45 % cap, zones wrap), page pushed 324; tray tucked → 232→1100, 228 px, page pushed 228; real keys: N switched to the pad, Esc hid it (scroll 0, padding 44), W opened, W again hid, **w typed in the search box did not open it**; 800 px → overlay (no push), tray open covers the right of the drawer (z 2900, same as before); 2 real invoice ROs (#6009, #6026); click #6009 → RO Board + that RO open, drawer stays. **RO #6033 round trip** (`ro` → `invoice` → `closed` → `invoice` → `ro`): appeared, disappeared on close, came back on reopen, left on restore — each via the 60 s catch-up, because realtime delivered no `repair_orders` events (see §5). Side effect: closing #6033 on the sandbox stamped its `closed_at` (kept on reopen, by design).
- **2026-09-24** — created (slices 1 + 2, staging only): the Desk pad became the bottom drawer's first tab and the Whiteboard its second (W); "Ready → call for pickup" = status `'invoice'`, read-only, live; Waiting on parts / Don't forget shown as "Coming next".
