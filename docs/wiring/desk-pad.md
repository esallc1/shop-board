# How the Desk pad is wired
> Doc: `/docs/wiring/desk-pad.md`
> Last updated: 2026-09-24 — **§3: 📌 on each sticky moves it to the Whiteboard (only after the server confirmed)**; §4 how the pad stays network-free. Earlier the same day: the pad became the first tab of a two-tab bottom drawer.
> §2 + §3 + Where-it-lives rewritten. Created 2026-09-23 (Front Desk redesign; design approved by Cris 2026-09-16).
> Verified vs commit `ab32ea2` (the one-📌-one-line fix driven on test.* 2026-09-24). Earlier checks: see the change log.
> Status: 🟢 **LIVE on prod** — the pad since `334868f`; the two-tab drawer since `968d376`; 📌 Pin to whiteboard since `d170604` (2026-09-24).
> Related: [[whiteboard]] (the drawer's second tab), [[messenger-tray]] (same mount pattern, shares the right edge),
> [[call-window-desk]] (untouched).

## 0. In one line
A scratch pad at the bottom of the advisor board — yellow sticky notes you jot on while you work and
throw away later — kept on **this computer only**, never in the database.

## 1. The picture (Cris)
The big desk-pad calendar on a real secretary's desk: jot anything, tear off the page when it's full.
Kevin says "get starter bolts for the Ford F-250, customer X" → Manny jots it, keeps working, crosses
it out later. **Notes are not linked to anything** (Cris rejected "Add to RO").

## 2. Where it is on the page — the bottom drawer
Since 2026-09-24 the pad is **one tab of a shared bottom drawer** (`shared/bottom-drawer.js`). The drawer
is the frame; each tab is a **panel** built by its own module: **📝 Desk pad** (this doc, key **N**) and
**📋 Whiteboard** ([[whiteboard]], key **W**).
- Mounted **once** by `advisor-board.html` (`mountFrontDeskDrawer({ db })` from
  `shared/front-desk-drawer.js`, in a module before `</body>`), appended to `<body>` outside every view —
  so it's on **every advisor tab**. No other board has it (yet — [[whiteboard]] §1).
- **Closed:** two small tabs side by side at the **bottom middle of the work area** (between the sidebar
  and the window edge — or the Facebook tray's edge while it's open): **"📝 Desk pad"** with the note
  count and an **N** hint, **"📋 Whiteboard"** with its count and a **W** hint. `.main-area` always keeps
  44 px at the bottom so the tabs never sit on the last card.
- **Open:** the drawer's header is the tab switcher (📝 Desk pad · 📋 Whiteboard), a subtitle, the shown
  panel's own buttons, and **Hide ▾**. **One panel at a time**: clicking the other tab (closed or in the
  header) switches to it; clicking the tab that's showing hides the drawer.
- **Height — start short, grow as needed (Cris, 2026-09-23).** The drawer is its header + **one row** of
  the shown panel to start (≈ ¼ of a laptop window). When notes wrap to a second row it grows to fit,
  a row at a time, up to **45 % of the window**; past that the panel scrolls inside. Deleting notes
  shrinks it back; switching panels resizes it to the new panel. It never goes below header + one row.
  Rule: `padHeight(chrome, content, viewportH)` in the logic module (chrome = the drawer header + the
  panel's own header, e.g. the tear-off confirm when shown; content = the panel's natural height — for
  the pad, the notes grid + its padding). A `ResizeObserver` on each panel's content re-applies it;
  window resizes re-apply it too.
- **Where:** docked at the bottom of the work area: left = the sidebar's right edge (232 px), right =
  the window edge, or **340 px while the Messenger tray is open** (`body.mtray-open`) so the two never
  overlap.
- **It pushes, it doesn't cover (≥ 900 px wide).** The page scrolls as a whole (the sidebar is
  `sticky`), so "push up" = `.main-area` gets bottom padding the drawer's height (`--bdr-h`, class
  `body.bdr-open`) **and** the window scrolls up by that height when it opens — what was at the bottom
  of the screen is now just above the drawer, and every card can still be scrolled to. A height change
  (more notes, switching panels) moves the page by the difference. **Hide** scrolls back down by the
  total and removes the padding. Crossing below 900 px while open undoes the push.
- **Below 900 px** it overlays, full width of the work area (full width on the phone layout, where the
  sidebar is off-canvas). No push.
- **z-index 2800** — below the Messenger tray (2900), every modal (3000), the call-log drawer (3300),
  the call card (4000), the mobile sidebar (4500), "Catch this moment" (5000) and Team Chat (9999).
  The call card, call log, Desk lanes and Team Chat are untouched.

## 3. What you can do
- **+ New note** (in the drawer's header while the pad shows, or the dashed tile after the last note) → an empty yellow
  sticky with the time (shop time), cursor in it. **Several at once**; they wrap in a grid.
- **Type** — saved as you type (no redraw, so the cursor never jumps).
- **×** on a sticky → that note is gone (no confirm).
- **📌** ("Pin to whiteboard", next to ×) → the sticky's text **moves** to the shared Whiteboard as a
  Don't forget line ([[whiteboard]] §6a), stamped with the signed-in person's name + time by the server.
  **The sticky leaves the pad only after the server confirmed** — if the post fails (offline, signed out,
  refused) the sticky **stays**, with a short red line under it saying why (it clears as soon as you
  type). Empty sticky → 📌 disabled (and it follows typing without a redraw). Over **500 characters** →
  "Too long for the whiteboard (612 / 500 characters) — shorten it first." — nothing is cut.
  **One pin at a time per sticky** (`createPinner`): while it's in flight the sticky says "pinning to the
  whiteboard…", is read-only, 📌 / × are locked, and another tap / Enter / Space does nothing — never a
  second post; nothing is retried by itself. If the answer never came clearly (offline / timeout / 5xx)
  it says "Couldn't confirm it reached the whiteboard — it's still here. Pinning again won't add it
  twice." (the server returns the existing line for an identical re-pin — [[whiteboard]] §8).
  Rules: `pinCheck` / `pinNoteFlow` / `createPinner`.
- **Tear off page** → an inline bar: **"Tear off this page? All notes will be removed."** · Tear off ·
  Cancel. (Inline, never a blocking `confirm()`.)
- **Hide ▾** → the drawer closes and the screen comes back down.
- **N** toggles the pad — **only** when focus is not in an input / textarea / select / contenteditable,
  with no Ctrl/⌘/Alt, not a held-down repeat (`isPadToggleKey`). N while the Whiteboard shows switches to
  the pad. Opened with N, the cursor goes into the first note (if any), else onto the pad's header tab.
  **W** does the same for the Whiteboard (`isBoardToggleKey`, same guards). **Esc** hides the drawer
  when it's open and focus is inside it (opening it puts focus there) — unless a field in a panel already
  used that Esc (`defaultPrevented`, e.g. the Whiteboard's write-on-board box closes only itself).
- Another browser tab on the same computer changing the pad → this one follows (`storage` event),
  unless you're typing in a note here.

## 4. Storage — this computer only
- `localStorage['cdDeskPad']` = `{ v: 1, notes: [{ id, text, time }] }`. Survives a refresh.
- **Every read and write is wrapped** (`loadNotes` / `saveNotes` in the logic module): private mode,
  blocked site data or a full quota → the pad still works in memory for this page; it just won't be
  there after a refresh.
- Junk in storage is cleaned, never trusted (`cleanNotes`): bad JSON, non-objects, missing/duplicate
  ids. Caps: 200 notes, 4,000 characters a note.
- **Nothing goes to the database or the network.** `shared/desk-pad.js` takes no Supabase client and
  makes no request — a test fails if it, `desk-pad-logic.js` or the drawer frame `bottom-drawer.js`
  mentions `supabase`, `db`, `.from(`, `.rpc(`,
  `.channel(`, `fetch(`, `cdAuthFetch` or `/api/`.
  - 📌 doesn't break that: the pad is handed one function, `pinToBoard(text)` → `{ ok, error }`, by
    `mountFrontDeskDrawer` (shared/front-desk-drawer.js), which wires it to the Whiteboard panel's
    `pin(text)` — the Whiteboard module does the post. A pad mounted without it shows no 📌.
- Per browser, per address: a note written on `www` isn't on `board.*` (same reason as sign-ins —
  [[hosting-domains]] §4a).

## Known gaps & open questions (as of 2026-09-24)
- **On a very short window (under ~667 px tall) two full rows don't quite fit the 45 % cap** (two rows
  need 300 px; 45 % of 640 is 288, so the 2nd row scrolls ~12 px). Cris checked on his laptop in full
  Chrome: 6 notes = two clean rows, nothing cut off — **no change to the cap or sticky height** (2026-09-23).
- The drawer's open/closed state is not remembered across a refresh (it starts closed) — on purpose, so a
  refresh never shoves the page up by surprise.
- No undo for × or Tear off.

## Where it lives in the code
- `shared/bottom-drawer.js` — the drawer frame: `mountBottomDrawer({ panels })` (tabs, switching, the
  push-up, the height rule applied to the shown panel, Hide, Esc, the N/W keys via each panel's `isKey`).
  No database, no network (test-locked).
- `shared/front-desk-drawer.js` — `mountFrontDeskDrawer({ db })`: the drawer with the Desk pad and the
  Whiteboard. The one call a board makes.
- `shared/desk-pad.js` — the pad panel: `createDeskPadPanel(ctx, { pinToBoard })` (📌 only when `pinToBoard` is given).
- `shared/desk-pad-logic.js` — pure rules: `addNote`, `deleteNote`, `updateNoteText`, `tearOff`,
  `cleanNotes`, `loadNotes`, `saveNotes`, `isTypingTarget`, `isPadToggleKey`, `isBoardToggleKey`,
  `PIN_MAX` / `pinCheck` / `pinNoteFlow` / `createPinner` (📌 — one flight per sticky; removes it only on a confirmed `{ ok: true }`),
  `noteTime`, `STORAGE_KEY`, and the height rule `padHeight` / `pushScrollTarget` (`CAP_RATIO` 0.45,
  `ONE_ROW_MIN` 132). Tested by `shared/desk-pad-logic.test.js`.
- `shared/bottom-drawer.css` — the frame's look (z 2800, the 900 px push/overlay switch, the tray-aware
  right edge, the header, shared buttons and colour tokens). `shared/desk-pad.css` — the stickies.
- `advisor-board.html` — the stylesheet `<link>`s and the mount module before `</body>`.

## Session change log
- **2026-09-24** — **slice 6 shipped to prod** as `d170604` (fast-forward `9a4fb2d..d170604`, Cris's OK after re-testing on test.* as ZZ Test Advisor: several quick 📌 taps → ONE line, sticky left, yellow flash; lasting "from desk pad" look parked). www / board. / apex `/api/version` = `d170604` (steady); the 8 changed served files byte-identical on all three; CLAUDE.md 404; `POST /api/whiteboard` no token → 401 (www, board.). Prod pane, read-only: drawer opened, N → a temporary LOCAL sticky (never pinned, thrown away with ×; the pad's storage back to 0) showed 📌 "Pin to whiteboard" next to ×; W → Whiteboard with the 5 Ready ROs + the parts zone. Nothing written on prod.
- **2026-09-24** — fix driven on test.* at `ab32ea2` (sandbox, ZZ Test Owner; the page's `cdAuthFetch` wrapped for the test, then restored): **rapid taps** — 3 clicks + 2 on the redrawn button + Enter, 3 s server delay → 1 call, 1 row; during: "pinning to the whiteboard…", 📌 + × disabled, text read-only; then the sticky left once. **Cris's case** — the post really stored, the page got a 503 → sticky stayed with "Couldn't confirm it reached the whiteboard — it's still here. Pinning again won't add it twice.", 📌 re-enabled, server 1 row; tap again → the server returned the existing line, sticky left, still 1 row. Test lines erased (soft). Of Cris's three "4L60 core" lines, the two extra were already erased by him; the first (12:51:57) stays as the one real pin.
- **2026-09-24** — bug fix (one 📌 → three whiteboard lines, see [[whiteboard]]'s log): `createPinner` (one pin per sticky, "pinning…", no auto-retry) + a clearer "couldn't confirm" message; the server now refuses to make a second identical line.
- **2026-09-24** — slice 6 driven on test.* at `0accb27` (sandbox, ZZ Test Owner): served files byte-identical (8). N → + New note → 📌 disabled while empty, enabled after typing (real keys) "Pin test: order 2 cases Mercon LV"; 📌 → sticky gone from the pad and from localStorage; W → the line under Don't forget "— ZZ Test Owner · 12:46 PM", highlighted (`is-fresh`). Failures (the page's `cdAuthFetch` swapped for the test, then restored): a 401 → sticky stays, "Your CrisData sign-in isn't active on this page — log out and sign in again."; a thrown fetch (offline) → stays, "Couldn't pin it to the whiteboard — it's still here. Try again."; 612 characters → stays, "Too long for the whiteboard (612 / 500 characters) — shorten it first." — none reached the board. Cleaned up: pad torn off, the pinned test line erased (soft).
- **2026-09-24** — slice 6 (staging): 📌 "Pin to whiteboard" on each sticky — posts the text as a Don't forget line through the injected `pinToBoard` (→ the Whiteboard panel's `pin` → `/api/whiteboard`), removes the sticky only on a confirmed success, keeps it with an error otherwise; empty → disabled; > 500 → clear message. The pad still makes no network call (test-locked). Known gap removed.
- **2026-09-24** — drawer Esc now skips an Esc a panel field already handled (the Whiteboard's write box, [[whiteboard]] §6). Staging.
- **2026-09-24** — the two-tab drawer **shipped to prod** as `968d376` (www / board. / apex byte-identical; N / W / Esc checked read-only on prod) — see [[whiteboard]].
- **2026-09-24** — drawer driven on test.* at `d158b6a` (1100 px tray open/tucked, 800 px overlay; real N / W / Esc; W typed in the search box did not open it) — see [[whiteboard]]'s change log for the numbers.
- **2026-09-24** — the pad became the first tab of a two-tab bottom drawer (📝 Desk pad N · 📋 Whiteboard W): frame moved to `shared/bottom-drawer.js`/`.css`, pad now `createDeskPadPanel`, mounted via `mountFrontDeskDrawer({ db })`; `isBoardToggleKey` added; notes behave as before. Staging only.
- **2026-09-23** — **shipped to prod** as `334868f` after Cris's OK in full Chrome on his laptop (1 note = one short row; 6 notes = two clean rows, nothing cut off; cap and sticky height unchanged). Fast-forward `5e688c8..334868f`; www / board. / apex byte-identical (7 served files; `/CLAUDE.md` 404).
- **2026-09-23** — height re-verified on test.* (`189588d`, 1024×640, ZZ Test Advisor): **1 note** → 176 px (28 %, one row, 20 px of paper under the notes), page pushed 176; 2 notes still one row (3 across); **3rd note wrapped → 288 px = the 45 % cap** (2 rows need 300 → ~12 px scroll); **5 notes** → 288, notes scroll inside; **10 notes** → 288, 254 px of inner scroll, tab count 10; deleted to 2 → **176 px, page came back down by exactly 112**; Hide → scroll 0, padding 44 px, inline height cleared.
- **2026-09-23** — height change requested by Cris after reviewing on a ~1000 px laptop: start with header + ONE row, grow a row at a time to fit, cap at 45 % of the window (then scroll inside), shrink back on delete; the push follows the real height. `padHeight` / `pushScrollTarget` + tests; notes grid wrapped in `.dpad-grid` so its natural height can be measured.
- **2026-09-23** — browser run on test.* (`bbe6832`, ZZ Test Advisor, 1100×720, Facebook tray open): N opened the pad on Approval Queue — page scrolled up exactly the pad's height (302 px), `.main-area` padding 314 px, pad 232→760 px = the tray's left edge; 3 notes added (saved as typed, stamped 12:34 ET), × deleted one, refresh kept 2 (pad starts closed); opened from the tab on **Desk** and with N on **RO Board** (notes follow); Esc from a note hid it and scrolled back to 0; real n/N keys in the Customers search typed "nN" and did NOT open the pad; Tear off → inline confirm → 0 notes on screen and in storage; tray tucked → pad 232→1100 px with the tray strip still visible. Fix during the run: the title wrapped to "Desk / pad" in the narrow pad → `white-space: nowrap` (`bbe6832`).
- **2026-09-23** — created. Desk pad on the advisor board: tab at the bottom middle, lined pad that pushes the page up (≥900 px) or overlays, yellow stickies (× / + New note / Tear off with inline confirm / Hide), N and Esc, localStorage only. On staging.
