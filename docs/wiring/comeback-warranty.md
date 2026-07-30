# How comeback / warranty is wired

> Doc: `/docs/wiring/comeback-warranty.md`
> Last updated: 2026-07-30 — verified vs commit `bea25cf`
> Status: ✅ verified vs commit `bea25cf` — every claim re-checked against `shared/comeback-chain.js`, `advisor-board.html`, `shared/warranty-mirror.js`, and the migrations.

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
- The rendered badge is `↩ Comeback N of RO ####` (the `↩` glyph is prepended by the UI at `advisor-board.html:4147`).

## 4. The close gate
- A comeback RO **cannot be closed** with the complaint or resolution empty. The block
  **names both** missing fields.
- Backed by migration `20260729_comeback_capture.sql` → `repair_orders.comeback_resolution`.

## 5. Why the old history is thin
- Comebacks were **never invoiced**, so nothing forced anyone to record what happened —
  that's why e.g. the green Chevy's four prior visits are gone. Fixed **going forward only**.
- Pre-CrisData (ALLDATA) invoice history was **deliberately not imported** ("it'll be a mess").

## Known gaps & open questions (as of 2026-07-30)
- **Pre-CrisData blind spot:** auto-detection can't catch comebacks/warranties on work
  done before CrisData — no parent RO exists in the platform to detect.
- **Proposed fix:** one-tap warranty/comeback marker on the **call window** (Josh tags it
  live when he recognizes the customer), flowing into intake. Extends the parked
  "complaint tag on calls."
- **Undecided:** comeback vs warranty — one flag or two distinct types?
- **Not built:** comeback ↔ floor-tag sync — picking Comeback in the wizard doesn't
  auto-set the red floor tag.
- **RESOLVED (verified Jul 30, `bea25cf`):** the missing comeback question is **intended
  gating, not a bug**. `selectExistingVehicle` (`advisor-board.html:3011`) looks up the
  most-recent prior RO **on that exact `vehicle_id`**; when there is none it sets
  `parentRoId = null` and jumps straight to mint as a new job (`advisor-board.html:3029-3033`),
  never showing the question. So the question fires only when a prior CrisData RO exists
  **for that vehicle** — which is also why the pre-CrisData blind spot above exists
  (no in-platform parent RO to detect).

## Where it lives in the code
- Comeback question / link: `selectExistingVehicle` + `cdStepComeback` in `advisor-board.html` (~3011–3042)
- Chain logic, badge & card: `shared/comeback-chain.js` (pure; tested by `shared/comeback-chain.test.js`);
  badge + chain-card render in `advisor-board.html` (~4146, ~4155)
- Close gate: `advisor-board.html:4910` (RO detail close), backed by `shared/comeback-chain.js` `validateComebackClose`
- Red floor **COMEBACK** tag (the `warranty` flag — separate from the chain): renders in
  `shop-board.html` (`.comeback-tag`, ~line 973/1145/1254); the RO-detail toggle writes it via
  `shared/warranty-mirror.js` into `shopboard_lifts / shopboard_parking / shopboard_pickup`.
  `repair_orders` has **no** warranty column — the flag lives only on the floor row.
- Migrations: `20260729_comeback_capture.sql` (`comeback_resolution`), `20260729_repair_orders_no_delete.sql` (anon loses DELETE)

## Session change log
- 2026-07-29 — Shipped badge, chain card & blocked close (`3f17c6f`). Added `comeback_resolution` column.
- 2026-07-29 — Killed W-numbering after finding the `po` string-join would silently drop lettered rows.
- 2026-07-30 — Seeded this doc from the handoff; opened the call-window warranty-tag idea; flagged the intake comeback-question gap.
- 2026-07-30 — Verified vs `bea25cf`: every claim re-checked against code/schema. Resolved the intake comeback-question VERIFY (intended vehicle-scoped gating, not a bug); added the cycle/depth badge case; corrected "where it lives" — the red floor tag lives in `shop-board.html` via `shared/warranty-mirror.js`, not `advisor-board.html`.
