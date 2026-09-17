# How floor tags & board lanes are wired

> Doc: `/docs/wiring/floor-tags.md`
> Last updated: 2026-07-30 — verified vs commit `bea25cf`
> Status: ✅ verified vs commit `bea25cf` (claims below re-checked). Still partial — the full lane
> taxonomy of the Shop Floor tab (`gm-board.html`) isn't documented yet. 2026-09-17: v1 `shop-board.html` deleted; render refs repointed.

## 0. In one line
Floor tags (e.g. the red COMEBACK tag) and the board lanes that group ROs by state.

## 1. Notes (verified vs code)
- Red **COMEBACK** floor tag = the `warranty` boolean on the floor rows
  (`shopboard_lifts / shopboard_parking / shopboard_pickup`); renders in the **Manager board's Shop Floor
  tab** (`gm-board.html` `.comeback-tag`, ~lines 3186 / 3349 / 3446; v1 `shop-board.html` deleted 2026-09-17). It is **separate from the RO's permanent comeback
  record** (`repair_orders.parent_ro_id`) — two different data sources. Turning it OFF sets
  `warranty=false` but **keeps** `comeback_flagged_at` (the historical stamp the comeback-rate
  metric reads), per `shared/warranty-mirror.js`.
- **Declined lane relative date (fixed):** `agoLabel` (`advisor-board.html:6173`) now owns the whole
  phrase including the "ago" suffix — same-day returns `'today'`, otherwise `'N days ago'` — and the
  caller (`advisor-board.html:6298`) no longer appends " ago". So the same-day row reads
  **"Declined today"**, not the old **"Declined today ago"**.
- **Known (confirmed):** declined estimates sort **last** in the `checking_on_car` picker —
  `roPickerRank` gives a declined estimate rank 4, below RO/estimate/invoice/closed
  (`shared/ro-calls.js:30`).

## Known gaps & open questions (as of 2026-07-30)
- comeback ↔ floor-tag sync not built: choosing **Comeback** in the intake wizard sets
  `parent_ro_id` but does **not** flip the floor `warranty` flag. The flag is set only by the
  manual "Warranty / Comeback" toggle on the RO detail (`advisor-board.html:4400`, via
  `shared/warranty-mirror.js`) or on gm-board's Shop Floor tab. Verified still true at `bea25cf`.

## Where it lives in the code
- Red COMEBACK tag render: **`gm-board.html`** Shop Floor tab (`.comeback-tag`, ~3186 / 3349 / 3446)
- Warranty/comeback floor-flag write: `shared/warranty-mirror.js`; RO-detail toggle at `advisor-board.html:4400`
- Declined lane + relative-date phrase: `advisor-board.html:6173` (`agoLabel`), `:6298` (Declined render)
- `checking_on_car` picker sort: `shared/ro-calls.js` (`roPickerRank` / `sortRosForPicker`)

## Session change log
- 2026-09-17 — v1 `shop-board.html` deleted; repointed the COMEBACK-tag render location to
  `gm-board.html` (verified the three `class="comeback-tag"` renders). Rest not re-verified.
- 2026-07-30 — Stub created.
- 2026-07-30 — Verified vs `bea25cf`: **corrected "where it lives"** — the red COMEBACK tag renders in
  `shop-board.html` (via the `warranty` floor flag / `shared/warranty-mirror.js`), not `advisor-board.html`
  as the stub implied. Confirmed the "Declined today ago" bug and the declined-last picker sort against code.
- 2026-07-30 — Fixed the "Declined today ago" bug: `agoLabel` now owns the "ago" suffix so same-day reads
  "Declined today" (code + this doc line updated in one commit).
