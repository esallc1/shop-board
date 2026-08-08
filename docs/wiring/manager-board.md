# How the Manager board Technicians table is wired

> Doc: `/docs/wiring/manager-board.md`
> Last updated: 2026-08-07 — verified vs commit `3535697`
> Status: ✅ BUILT + verified live. The **Billed Hrs** column is now real (per-tech,
> current week) behind the Book Hours switch; Clocked Hrs / Efficiency / time-punches
> remain sample. Feature OFF → the table looks exactly like before (all sample).

## 0. In one line
The Manager board (`gm-board.html`) **Technicians** tab lists active techs and, per
tech, **Active Jobs** (live, from floor rows), **Billed Hrs** (live this-week rollup
when the Book Hours feature is ON — else sample), and **Clocked Hrs / Efficiency**
(still sample — no time-clock source yet).

## 1. The table
- **View:** `#view-technicians`; content injected into `#tech-grid-wrap`. Rendered by
  `renderTechnicians(allActive, pickupData, billedHrs)` (`gm-board.html:2213`), called
  once from `loadAndRender()` (which first `await computeBilledHours()` and passes it).
- **Tech list:** `loadTechPageTechs()` → `employees` `role='tech'` `active=true` (names).
- **Columns:** Technician · Active Jobs · **Billed Hrs** · Clocked Hrs · Efficiency ·
  Ready for Pickup.
  - **Active Jobs / Ready for Pickup** — LIVE, bucketed from floor rows
    (`shopboard_*.assigned_tech`) and the pickup lane.
  - **Billed Hrs** — LIVE when the Book Hours switch is on (see §2); otherwise the
    `dummyHours(name)` sample.
  - **Clocked Hrs / Efficiency** — SAMPLE (`dummyHours` name-hash). Efficiency is
    `sampleBilled / sampleClocked` (kept on the sample billed so the ratio stays
    self-consistent). Time-clock punches (`DUMMY_PUNCHES`) are sample too.

## 2. Billed Hrs — the live weekly rollup
- **Gate:** `bookHoursFeatureOnGm()` reads `BoardSettings.getShopSettings().feature_book_hours`.
  `computeBilledHours()` (`gm-board.html:2171`) returns **null when OFF** → the renderer
  uses the sample values and the sample header/banner, so the board is unchanged.
- **What it computes (per tech, current week):** `Σ` labor-line hours credited to that
  tech (`ro_line_items.line_tech_id` → employee name, else the RO's `technician`) `+ Σ`
  package `rr_hours` on ROs where they're the assigned tech. Full definition lives in
  [[flat-rate-hours]] §10.
- **Bucketed by a STABLE stamp — `repair_orders.closed_at`** (set once the first time an
  RO enters invoice/closed, never overwritten; DB trigger). So a closed RO edited later
  never shifts its pay hours to another week. Falls back to `updated_at` pre-migration
  (probe cached in `closedAtColAvailable`). Scope stays `status IN ('invoice','closed')`.
- **Week:** Sunday–Saturday, **America/New_York** (same as the bookkeeping board) —
  `nyWeekSunSat()` / `nyDateOf()`.
- **Header + banner reflect live-vs-sample:** with Book Hours ON, the Billed Hrs header
  shows a green `live · this wk` tag (Clocked/Efficiency keep `sample`), and the banner
  switches to "Billed Hrs is live … Clocked/Efficiency … still sample." OFF → the
  original all-sample warning banner + `sample` tags.

## Known gaps & open questions (as of 2026-08-07)
- **Clocked Hrs / Efficiency are sample** — they need a time-clock (punch) source,
  a later step. Efficiency can't be real until Clocked is.
- **One 400 in the console pre-migration:** `computeBilledHours` selects
  `repair_orders.closed_at` (and `ro_line_items.line_tech_id`); until each is migrated
  that select 400s **once** — a session-cached flag (`closedAtColAvailable` /
  `lineTechColAvailable`) then stops probing and the code re-queries without it (bucketing
  falls back to `updated_at`). The 400s disappear once the columns exist. `line_tech_id`
  is already applied; `closed_at` (`20260807_ro_closed_at.sql`) is **now applied too**
  (verified live 2026-08-08: the column exists and is stamped on all 33 invoice/closed
  ROs), so that probe no longer 400s.

## Where it lives in the code
- `gm-board.html`: `renderTechnicians`, `computeBilledHours` (buckets by `closed_at`),
  `nyWeekSunSat` / `nyDateOf`, `bookHoursFeatureOnGm`, `closedAtColAvailable` /
  `lineTechColAvailable`, `dummyHours` (sample), `loadTechPageTechs`, banner
  `.tech-sample-banner`, and the `.live-tag` / `.sample-tag` header styles.
- **Related docs:** [[flat-rate-hours]] (§10 the rollup definition + the RO book-hours
  auto-total), [[ro-line-items]] (`line_tech_id`, the labor Tech-credit picker),
  [[tech-board]] (the floor/dispatcher that feeds Active Jobs), [[settings]] (the Book
  Hours switch).

## Session change log
- 2026-08-07 — Created (Hours Engine Part 1). Lit up the real **Billed Hrs** column on
  the Technicians table via a weekly per-tech rollup (`computeBilledHours`), behind the
  Book Hours switch (OFF → sample, unchanged). Relabeled the header (green `live · this
  wk` on Billed Hrs; `sample` stays on Clocked/Efficiency) and the banner. Verified live:
  billed `{Cory:9, Alex:3}` for the Aug 2–8 week matched an independent DB sum; OFF path
  renders all-sample.
- 2026-08-07 — Billed Hrs now buckets by the **stable set-once `repair_orders.closed_at`**
  (was `updated_at`, which drifted) — see [[flat-rate-hours]] §10 /
  `migrations/20260807_ro_closed_at.sql`. Resilient fallback to `updated_at` pre-migration
  (probe cached). Verified: fallback returns the same `{Cory:9, Alex:3}`.
