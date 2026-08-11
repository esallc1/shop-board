# How Profit by RO is wired

> Doc: `/docs/wiring/profit-by-ro.md`
> Last updated: 2026-08-11 — verified vs branch `profit-by-ro` (Step A, in-browser on the
> owner board; bookkeeping verified by structure + owner eyeball on the preview)
> Status: 🟡 Step A BUILT (rename + shell + period selector + KPI row on real closed-RO
> data). Step B (ranked-bar per-RO list + honesty flags) and Step C (donut/split toggle)
> NOT built. Reads-only — no writes, no migration, no feature switch.

## 0. In one line
A **"Profit by RO"** screen in the Cost & Profit sidebar group (Owner + Bookkeeping only)
that shows **per-JOB profit on the repair orders CLOSED in a selected period** — sale minus
an estimated cost — answering "how profitable was the work we billed?". It replaced the dead
**"Cockpit"** Step-3 placeholder.

## 1. What it is — and what it deliberately is NOT
- **Keyed on CLOSED ROs:** a repair order counts when its **`repair_orders.closed_at`**
  (bucketed to the shop's calendar day, America/New_York) falls inside the selected period.
  `closed_at` is the stamp set once when an RO first hits `invoice`/`closed` and never moves
  (see [[flat-rate-hours]] / the `20260807_ro_closed_at.sql` migration).
- **NOT the Financial Pulse.** [[financial-pulse]] is **realized/cash-basis** — money actually
  collected, gated on paid-in-full, bucketed by `paid_at`. Profit by RO is **accrual/per-job** —
  the profit of work *billed* in the period, regardless of whether the customer has paid. The
  two answer different questions and are **not** meant to tie out. (They share only the date
  math, §2.)
- **Sale is REAL, profit is ESTIMATED.** The section header says so in words. Sale is the true
  sum of the RO's line items (pre-tax); profit rides on assumed margins until per-RO costs are
  confirmed (§3).

## 2. The period selector — shared with Financial Pulse (one copy of the math)
- **Presets:** This week / Last week / This month / Last month / This quarter / Last quarter /
  Custom — the **same set, same order** as the Financial Pulse control. **Default = Last week**
  (the most recent completed Sun–Sat calendar week).
- **The window math is not forked.** Both screens call **`shared/period-range.js`**
  (`window.PeriodRange`): `rangeFor(preset, {customFrom, customTo})` → `[start, end]` inclusive
  local Dates, plus `ymd`/`parseYmd`/`addDays`/`startOfWeek`/`daysBetween`/`currentRange`/
  `fmtRangeLabel`/`nyDate`. Conventions are identical to the Pulse: **week = calendar Sunday →
  Saturday** containing the anchor day (not clipped to today); **month/quarter = calendar,
  "this" is to-date, "last" is the whole previous period**; custom parses two `YYYY-MM-DD`
  inputs (swapped if from > to). Financial Pulse was refactored to delegate to this same module
  in the same change ([[financial-pulse]] §4), so "last week" can never mean two things.
- **On change:** picking a preset (or editing a custom date) re-renders the KPI row from the
  already-fetched data — no refetch. The "Showing X – Y" label reflects the actual window.

## 3. Per-RO cost & profit — reuses the commission engine, no parallel path
The cost/profit math is **`window.CommissionEngine`** (`shared/commission-engine.js`) — the
same engine the Advisor Commission rollup uses — so there is exactly one definition of a line's
gross profit in the app. Profit by RO does **not** compute cost its own way.
- **Per line (`CommissionEngine.lineGrossProfit`):**
  - **package** → `rev − qty × package_units.unit_cost` when that unit's cost is **confirmed**
    (the green "Confirmed cost" from the Build Sheet, [[cost-profit]] §10); otherwise the
    **assumed package margin** — `rev × 0.55` by default (`DEFAULT_PACKAGE_MARGIN`), i.e. cost =
    45% of price. `shop_settings.package_margin_pct` overrides the 0.55 if set.
  - **parts** → `rev − qty × unit_cost` when the line carries a real `unit_cost`, else
    `rev × 0.40` (`DEFAULT_PARTS_MARGIN`, or `shop_settings.parts_margin_pct`).
  - **labor** → `rev` (**treated as 100% margin** — no modeled COGS). ⚠ This is the single
    biggest driver of the headline margin at this shop; see Known gaps.
  - **fee / shop_supply / hazmat** → `0` (revenue counts toward the sale but contributes no
    modeled profit).
- **Per RO:** `profit = CommissionEngine.roGrossProfit(lines, opts)`;
  `sale = Σ(quantity × unit_price)` over all the RO's lines (pre-tax, every line type).
- **The `opts` object** is built once from `BoardSettings.getShopSettings()` (margins) + a
  `{package_unit_id → unit_cost}` map from `package_units`, exactly as `CommissionEngine.compute`
  builds it.

## 4. The KPI row (Step A — the only content today)
Four tiles, computed over the closed ROs in the range:
- **Week sales** = `Σ RO sale` — badged **real · pre-tax**.
- **Est. week profit** = `Σ RO profit` — prefixed `~`, badged **estimated cost**.
- **Avg profit / RO** = `Est. week profit ÷ RO count` — `~`, shows the RO count.
- **Avg margin** = `Est. week profit ÷ Week sales` — `~`, badged **estimated**.
Empty period → "No repair orders were closed in this period." (tiles suppressed).

## 5. Where it mounts (Owner + Bookkeeping only)
- **Nav + view:** the Cost & Profit `sidebar-group` item `data-view="profitro"` (📈 "Profit by
  RO") and the `#view-profitro` container holding `#profitro-root`. Same access as the old
  Cockpit — Owner + Bookkeeping boards only; Manager/Advisor untouched.
- **Mount:** `ProfitByRO.mount(document.getElementById('profitro-root'), { db })` — on the
  owner board via a nav-item click listener; on the bookkeeping board via
  `activateView('profitro')`. `mount()` rebuilds the shell and **refetches** each open (fresh
  closed-RO numbers), matching the Build Sheet's mount model.
- **Data fetch:** `CommissionEngine.fetchInputs(db)` — the canonical read (ROs with
  `closed_at`, line items with `unit_cost`/`package_unit_id`, `package_units.unit_cost`). It
  degrades quietly on a missing column, so a pre-migration schema still renders with fallbacks.

## Known gaps & open questions (as of 2026-08-11)
- **Labor = 100% margin dominates the number.** In the shop's live data, rebuild work is billed
  largely as **`labor`** lines, which the commission engine models as pure profit. On the
  verified Aug 2–8 sample (13 closed ROs, $23,735 sales) labor was **$21,360 of that sales**, so
  the blended margin came out **~93%**, not the ~58% the design mockup assumed (the mockup
  assumed a flat ~55% margin on the whole sale). **This is faithful to the specified cost logic,
  not a bug** — but whether labor should carry an assumed cost (a labor COGS / effective-rate
  haircut) is an **open product decision** for Step B, not something to silently patch in.
- **Almost no confirmed costs yet.** Only **1 of 50** `package_units` had a confirmed
  `unit_cost` at Step A, and the sample week had **zero package lines**, so package profit is
  entirely the 55% estimate when packages do appear. The board sharpens unit-by-unit as costs
  are confirmed in the Build Sheet ([[cost-profit]] §10).
- **The "last mile" (real per-RO parts + labor cost) is not wired** — the mockup's own note flags
  it as the next data piece. Until then profit is an estimate by construction.
- **Not built:** Step B (ranked-bar per-RO list + no-advisor / confirmed-vs-estimated honesty
  flags) and Step C (donut / bars / split toggle).

## Where it lives in the code
- **`shared/profit-by-ro.js`** — `window.ProfitByRO.mount`; the scoped `.pro-*` styles; the
  period selector + KPI render; `computeKpis` (closed-RO filter + sale + `roGrossProfit`);
  `buildOpts` (margins + package-cost map); `loadData` (`CommissionEngine.fetchInputs`).
- **`shared/period-range.js`** — `window.PeriodRange`, the shared window math (§2), also used by
  [[financial-pulse]].
- **`shared/commission-engine.js`** — `roGrossProfit`/`lineGrossProfit` + `DEFAULT_PARTS_MARGIN`
  (0.40) / `DEFAULT_PACKAGE_MARGIN` (0.55); exposed as `window.CommissionEngine` on both boards.
- **`owner-board.html`** — the `data-view="profitro"` nav item, `#view-profitro` / `#profitro-root`,
  the `<script src="shared/period-range.js">` + `<script src="shared/profit-by-ro.js">` includes,
  and the nav-click mount.
- **`bookkeeping-board.html`** — same nav item + view + includes; `activateView('profitro')`
  mounts it.
- **Schema (read-only):** `repair_orders.closed_at`, `ro_line_items`
  (`line_type`/`quantity`/`unit_price`/`unit_cost`/`package_unit_id`), `package_units.unit_cost`,
  `shop_settings.parts_margin_pct`/`package_margin_pct`. No migration — this feature only reads.
- **Related docs:** [[financial-pulse]] (the realized/cash sibling + the shared date math),
  [[cost-profit]] (where package `unit_cost` is confirmed), [[advisor-commission]] (the engine
  that owns the profit math), [[packages]] (the unit list).

## Session change log
- 2026-08-11 — **Created. Built Step A** — renamed the dead "Cockpit" nav item + view/route to
  **"Profit by RO"** (Owner + Bookkeeping, same access); added a period selector mirroring the
  Financial Pulse (default Last week) backed by the **new shared `shared/period-range.js`**
  (`window.PeriodRange`) — and refactored Financial Pulse to delegate to that same module so the
  date math isn't forked ([[financial-pulse]] §4); wired the KPI row (Week sales / Est. week
  profit / Avg profit-per-RO / Avg margin) on real closed-RO data, reusing
  `CommissionEngine.roGrossProfit` for per-RO cost (confirmed `package_units.unit_cost` where
  saved, else the 0.55 margin fallback) — no parallel cost path. Verified in-browser on the
  owner board: nav rename, all 7 presets + custom resolve correct windows, KPI computes on the
  Aug 2–8 sample (13 ROs, $23,735 sales), empty-period state, no console errors from the module.
  Flagged the labor-as-100%-margin finding (~93% blended margin on the sample) for the owner's
  Step-B decision. Step B (ranked bars) + Step C (donut/split) NOT built.
