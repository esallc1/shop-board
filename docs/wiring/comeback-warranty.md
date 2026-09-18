# How comeback / warranty is wired

> Doc: `/docs/wiring/comeback-warranty.md`
> Last updated: 2026-09-18 — **§6 added: when the RO detail's Warranty toggle (and Status
> dropdown) re-read the floor row** — fixes "dead until the RO is closed and reopened".
> Branch `fix/floor-controls-refresh` off `main` `baecd25`, **unmerged**. §6, Known gaps and
> Where-it-lives re-checked against the code this session (all line numbers re-pointed);
> §1–§5 not re-verified. Staging browser pass recorded in the change log.
> Previously: 2026-07-30 — ✅ verified vs commit `bea25cf` — every claim re-checked against `shared/comeback-chain.js`, `advisor-board.html`, `shared/warranty-mirror.js`, and the migrations.

## 0. In one line
A comeback is a car returning about work we already did. It's its own RO, linked back
to the earlier one, shown with a **badge** and a **chain card**, and it **can't be
closed** without recording what the customer said and what we did.

## 1. What counts as a comeback
- Returning about prior work = comeback, **even if nothing's actually wrong**.
- **False-alarm rule:** "no issue found" is still logged as the resolution — that's
  exactly what proves later that a fine car got brought back three times.
- The red floor **COMEBACK tag** is a work-in-progress indicator and comes off when the
  car clears. The RO's comeback *record* stays forever. Two different things — don't
  conflate them.

## 2. Numbering — why there's no "W"
- `ro_number` is an integer identity column; `po` is a generated mirror of it. A letter
  is **unstorable**.
- The floor mirror joins on `po` string equality, so a `W6014` row would **silently
  fail to match**. **W-numbering is dead.**
- Instead: the badge reads **"Comeback N of RO ####"**. The integer RO# stays the only
  identifier everywhere.

## 3. How the chain links
- `parent_ro_id` points at the **immediate** parent, not the root.
- The ordinal ("N of") is computed by **walking parent links up to the root**
  (`analyzeChain` in `shared/comeback-chain.js`). Verified: `ordinal = ancestors up to & incl. root`.
- Orphan (parent deleted): reads **"Comeback (linked RO deleted)"** — never a guessed number.
- A **looping/over-deep** chain (cycle, or > `MAX_CHAIN_DEPTH` = 50) reads **"Comeback (chain error)"** —
  also never a guessed number. The walk guards against cycles and caps depth.
- The rendered badge is `↩ Comeback N of RO ####` (the `↩` glyph is prepended by the UI in `loadComebackChain`, `advisor-board.html:5840`).

## 4. The close gate
- A comeback RO **cannot be closed** with the complaint or resolution empty. The block
  **names both** missing fields.
- Backed by migration `20260729_comeback_capture.sql` → `repair_orders.comeback_resolution`.

## 5. Why the old history is thin
- Comebacks were **never invoiced**, so nothing forced anyone to record what happened —
  that's why e.g. the green Chevy's four prior visits are gone. Fixed **going forward only**.
- Pre-CrisData (ALLDATA) invoice history was **deliberately not imported** ("it'll be a mess").

## 6. The RO detail's Warranty toggle — when it's read (and why it used to go dead)
The toggle (`#cdRoWarranty`, "Warranty / Comeback") sets the floor row's `warranty` flag
(ON also stamps `comeback_flagged_at` once), via `setWarrantyCore` → `shared/warranty-mirror.js`
`mirrorWarranty`, which **re-resolves the floor row at write time** and never creates one. It
needs a floor row (by `po`, across `shopboard_parking` / `_lifts` / `_pickup`); without one it is
**disabled** with "Check the car in first to flag warranty." The work-**Status** dropdown
(`#cdRoStatusFloor`) has the same dependency (plus: disabled on pickup).

**The bug (fixed 2026-09-18):** both were painted from ONE floor lookup when the RO opened, and
never again. A floor row that appeared later — from this RO's own **Check in / Arrived**, from
**assigning a tech** (auto-check-in), or from anyone else — left both disabled, still telling
you to check in, until the RO was closed and reopened.

**Now — `refreshFloorControls()`** re-reads both (`populateWarrantyToggle` +
`populateStatusFloor`, in parallel) at four moments:
1. **RO open** — with the "Checking floor…" loading state (via `populateRoEditFields`);
2. **after this RO's Check in / Arrived succeeds** (the `paintArrivedBtn` `onDone` callback);
3. **after a successful tech assign** (`onTechAssignChange` — assign can auto-check-in or move
   the car to `waiting-tech`);
4. **tab return** (`VIEW_REFRESH.cdros.refetch`, only while an RO detail is open) — **quiet**:
   no loading flash, and a failed read keeps what's on screen instead of disabling it.

**Stale-reply guard (real, tested):** replies can overlap, so each one paints only if — when it
lands — it is still the **newest** refresh, the **same RO** is still open, and **no floor write**
started meanwhile (the Warranty and Status change handlers call `floorGate().invalidate()` before
writing, so the write's own result wins). The rule is `shared/floor-refresh-gate.js`
(`createFloorRefreshGate`, 6 tests), loaded as `window.FloorRefreshGate`; an identical inline
fallback covers the moment before the module loads. (The old code had a comment claiming a race
guard but no guard.)

**Not live (parked):** a car checked in / moved / cleared by **someone else** doesn't refresh an
open RO until one of the four moments above (e.g. switching tabs and back). See Known gaps.

## Known gaps & open questions (as of 2026-09-18)
- **Parked follow-up — live floor refresh for an open RO (§6):** subscribe the RO view's channel
  (`subscribeRealtime`, `advisor-board-cdros-live`) to the three `shopboard_*` tables and call
  `refreshFloorControls` when a change touches the open RO's `po` (any DELETE → refresh, since a
  delete payload may lack `po`). Skipped 2026-09-18 by decision: the **sandbox has no realtime
  publication**, so it can't be proven on staging.
- **Pre-CrisData blind spot:** auto-detection can't catch comebacks/warranties on work
  done before CrisData — no parent RO exists in the platform to detect.
- **Proposed fix:** one-tap warranty/comeback marker on the **call window** (Josh tags it
  live when he recognizes the customer), flowing into intake. Extends the parked
  "complaint tag on calls."
- **Undecided:** comeback vs warranty — one flag or two distinct types?
- **Not built:** comeback ↔ floor-tag sync — picking Comeback in the wizard doesn't
  auto-set the red floor tag.
- **RESOLVED (verified Jul 30, `bea25cf`):** the missing comeback question is **intended
  gating, not a bug**. `selectExistingVehicle` (`advisor-board.html:4283` as of 2026-09-18) looks up the
  most-recent prior RO **on that exact `vehicle_id`**; when there is none it sets
  `parentRoId = null` and jumps straight to mint as a new job (`advisor-board.html` ~4295–4302 as of 2026-09-18),
  never showing the question. So the question fires only when a prior CrisData RO exists
  **for that vehicle** — which is also why the pre-CrisData blind spot above exists
  (no in-platform parent RO to detect).

## Where it lives in the code
(line numbers as of 2026-09-18)
- Comeback question / link: `selectExistingVehicle` (`advisor-board.html:4283`) + the `cdStepComeback` step (~4313)
- Chain logic, badge & card: `shared/comeback-chain.js` (pure; tested by `shared/comeback-chain.test.js`);
  badge + chain-card render in `loadComebackChain` (`advisor-board.html:5820`; badge text ~5840)
- Close gate: `advisor-board.html` ~7121 (RO detail close), backed by `shared/comeback-chain.js` `validateComebackClose`
- **RO detail Warranty toggle (§6):** markup `#cdRoWarrantyField` (:2296); `floorGate` (:5974) /
  `refreshFloorControls` (:5988); `populateStatusFloor` (:6000); `populateWarrantyToggle` (:6115);
  `findFloorRow` (:6230) / `setWarrantyCore` (:6247); change handlers — Warranty (:7510), Status
  (:7535); refresh callers — check-in `onDone` (:6423), `onTechAssignChange` (:7469, refresh
  :7492), `VIEW_REFRESH.cdros` (:8421). Guard: `shared/floor-refresh-gate.js` (+`.test.js`).
- Red floor **COMEBACK** tag (the `warranty` flag — separate from the chain): renders in
  `gm-board.html`'s Shop Floor tab (`.comeback-tag`, ~line 3171/3334/3431; v1 `shop-board.html` deleted 2026-09-17); the RO-detail toggle writes it via
  `shared/warranty-mirror.js` into `shopboard_lifts / shopboard_parking / shopboard_pickup`.
  `repair_orders` has **no** warranty column — the flag lives only on the floor row.
- Migrations: `20260729_comeback_capture.sql` (`comeback_resolution`), `20260729_repair_orders_no_delete.sql` (anon loses DELETE)

## Session change log
- 2026-09-18 — **§6: Warranty toggle + Status dropdown no longer go dead.** Added
  `refreshFloorControls` (re-read on open, after this RO's check-in, after a tech assign, and
  quietly on tab return) with a real stale-reply guard (`shared/floor-refresh-gate.js`, 6 tests).
  Live floor channel parked (Known gaps). Line refs in §3 / Known gaps / Where-it-lives
  re-pointed. Branch `fix/floor-controls-refresh`.
- 2026-09-17 — v1 `shop-board.html` deleted; repointed the floor COMEBACK-tag render to
  `gm-board.html` Shop Floor (verified). Rest not re-verified.
- 2026-07-29 — Shipped badge, chain card & blocked close (`3f17c6f`). Added `comeback_resolution` column.
- 2026-07-29 — Killed W-numbering after finding the `po` string-join would silently drop lettered rows.
- 2026-07-30 — Seeded this doc from the handoff; opened the call-window warranty-tag idea; flagged the intake comeback-question gap.
- 2026-07-30 — Verified vs `bea25cf`: every claim re-checked against code/schema. Resolved the intake comeback-question VERIFY (intended vehicle-scoped gating, not a bug); added the cycle/depth badge case; corrected "where it lives" — the red floor tag lives in `shop-board.html` via `shared/warranty-mirror.js`, not `advisor-board.html`.
