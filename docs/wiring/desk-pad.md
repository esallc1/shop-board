# How the Desk pad is wired
> Doc: `/docs/wiring/desk-pad.md`
> Last updated: 2026-09-23 — created with the Desk pad (Front Desk redesign piece; design approved by Cris 2026-09-16,
> "Advisor Front Desk" mockup step 8).
> Verified vs commit `bbe6832` (staging; `main` waits for Cris's OK on the screenshots).
> Status: 🟡 **On staging** until Cris approves.
> Related: [[messenger-tray]] (same mount pattern, shares the right edge), [[call-window-desk]] (untouched).

## 0. In one line
A scratch pad at the bottom of the advisor board — yellow sticky notes you jot on while you work and
throw away later — kept on **this computer only**, never in the database.

## 1. The picture (Cris)
The big desk-pad calendar on a real secretary's desk: jot anything, tear off the page when it's full.
Kevin says "get starter bolts for the Ford F-250, customer X" → Manny jots it, keeps working, crosses
it out later. **Notes are not linked to anything** (Cris rejected "Add to RO").

## 2. Where it is on the page
- Mounted **once** by `advisor-board.html` (`mountDeskPad()` in a module before `</body>`), appended to
  `<body>` outside every view — so it's on **every advisor tab**. No other board has it.
- **Closed:** a small **"📝 Desk pad"** tab at the **bottom middle of the work area** (between the
  sidebar and the window edge — or the Facebook tray's edge while it's open), with a note count and an
  **N** key hint. `.main-area` always keeps 44 px at the bottom so the tab never sits on the last card.
- **Height — start short, grow as needed (Cris, 2026-09-23).** The pad is its header + **one row** of
  stickies to start (≈ ¼ of a laptop window, very little empty paper). When notes wrap to a second row it
  grows to fit, a row at a time, up to **45 % of the window**; past that the notes scroll inside the
  pad. Deleting notes shrinks it back. It never goes below header + one row, even on a short window.
  Rule: `padHeight(chrome, content, viewportH)` in the logic module (chrome = top bar + the tear-off
  confirm when shown; content = the notes grid's natural height + its padding). A `ResizeObserver` on
  the grid re-applies it whenever the notes change size; window resizes re-apply it too.
- **Open:** a lined pad (height per the rule above) docked at the bottom of the work area:
  left = the sidebar's right edge (232 px), right = the window edge, or **340 px while the Messenger
  tray is open** (`body.mtray-open`) so the two never overlap.
- **It pushes, it doesn't cover (≥ 900 px wide).** The page scrolls as a whole (the sidebar is
  `sticky`), so "push up" = `.main-area` gets bottom padding the pad's height (`--dpad-h`) **and** the
  window scrolls up by that height when it opens — what was at the bottom of the screen is now just
  above the pad, and every card can still be scrolled to. **Hide** scrolls back down by the same amount
  and removes the padding. Crossing below 900 px while open undoes the push.
- **Below 900 px** it overlays, full width of the work area (full width on the phone layout, where the
  sidebar is off-canvas). No push.
- **z-index 2800** — below the Messenger tray (2900), every modal (3000), the call-log drawer (3300),
  the call card (4000), the mobile sidebar (4500), "Catch this moment" (5000) and Team Chat (9999).
  The call card, call log, Desk lanes and Team Chat are untouched.

## 3. What you can do
- **+ New note** (in the pad's top bar, or the dashed tile after the last note) → an empty yellow
  sticky with the time (shop time), cursor in it. **Several at once**; they wrap in a grid.
- **Type** — saved as you type (no redraw, so the cursor never jumps).
- **×** on a sticky → that note is gone (no confirm).
- **Tear off page** → an inline bar: **"Tear off this page? All notes will be removed."** · Tear off ·
  Cancel. (Inline, never a blocking `confirm()`.)
- **Hide ▾** → the pad closes and the screen comes back down.
- **N** toggles the pad — **only** when focus is not in an input / textarea / select / contenteditable,
  with no Ctrl/⌘/Alt, not a held-down repeat (`isPadToggleKey`). **Esc** hides it when it's open and
  focus is inside the pad.
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
  makes no request — a test fails if either file mentions `supabase`, `db`, `.from(`, `.rpc(`,
  `.channel(`, `fetch(`, `cdAuthFetch` or `/api/`.
- Per browser, per address: a note written on `www` isn't on `board.*` (same reason as sign-ins —
  [[hosting-domains]] §4a).

## Known gaps & open questions (as of 2026-09-23)
- **Not in this slice: "📌 Whiteboard"** on a sticky (post it to the shared Front Desk whiteboard) — needs
  the whiteboard and a notes table first.
- The pad's open/closed state is not remembered across a refresh (it starts closed) — on purpose, so a
  refresh never shoves the page up by surprise.
- No undo for × or Tear off.

## Where it lives in the code
- `shared/desk-pad.js` — the DOM half: `mountDeskPad()`.
- `shared/desk-pad-logic.js` — pure rules: `addNote`, `deleteNote`, `updateNoteText`, `tearOff`,
  `cleanNotes`, `loadNotes`, `saveNotes`, `isTypingTarget`, `isPadToggleKey`, `noteTime`, `STORAGE_KEY`,
  and the height rule `padHeight` / `pushScrollTarget` (`CAP_RATIO` 0.45, `ONE_ROW_MIN` 132).
  Tested by `shared/desk-pad-logic.test.js`.
- `shared/desk-pad.css` — the look (z 2800, the 900 px push/overlay switch, the tray-aware right edge).
- `advisor-board.html` — the stylesheet `<link>` and the mount module before `</body>`.

## Session change log
- **2026-09-23** — height change requested by Cris after reviewing on a ~1000 px laptop: start with header + ONE row, grow a row at a time to fit, cap at 45 % of the window (then scroll inside), shrink back on delete; the push follows the real height. `padHeight` / `pushScrollTarget` + tests; notes grid wrapped in `.dpad-grid` so its natural height can be measured.
- **2026-09-23** — browser run on test.* (`bbe6832`, ZZ Test Advisor, 1100×720, Facebook tray open): N opened the pad on Approval Queue — page scrolled up exactly the pad's height (302 px), `.main-area` padding 314 px, pad 232→760 px = the tray's left edge; 3 notes added (saved as typed, stamped 12:34 ET), × deleted one, refresh kept 2 (pad starts closed); opened from the tab on **Desk** and with N on **RO Board** (notes follow); Esc from a note hid it and scrolled back to 0; real n/N keys in the Customers search typed "nN" and did NOT open the pad; Tear off → inline confirm → 0 notes on screen and in storage; tray tucked → pad 232→1100 px with the tray strip still visible. Fix during the run: the title wrapped to "Desk / pad" in the narrow pad → `white-space: nowrap` (`bbe6832`).
- **2026-09-23** — created. Desk pad on the advisor board: tab at the bottom middle, lined pad that pushes the page up (≥900 px) or overlays, yellow stickies (× / + New note / Tear off with inline confirm / Hide), N and Esc, localStorage only. On staging.
