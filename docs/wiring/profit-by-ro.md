# How Profit by RO is wired

> Doc: `/docs/wiring/profit-by-ro.md`
> Last updated: 2026-08-11 — verified vs branch `profit-by-ro` (Step A, in-browser on the
> owner board; bookkeeping verified by structure + owner eyeball on the preview)
> Status: ✅ Steps A + B + C BUILT — rename + shell + period selector + KPI row + the
> ranked-bar per-RO list (honesty flags) + the Bars/Donut/Split graph toggle, all on
> real closed-RO data. Reads-only — no writes, no migration, no feature switch. Verified
> in-browser on the owner board; awaiting the owner's go to ship A+B+C to prod together.

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

## 4. The KPI row (Step A)
Four tiles, computed over the closed ROs in the range:
- **Week sales** = `Σ RO sale` — badged **real · pre-tax**.
- **Est. week profit** = `Σ RO profit` — prefixed `~`, badged **estimated cost**.
- **Avg profit / RO** = `Est. week profit ÷ RO count` — `~`, shows the RO count.
- **Avg margin** = `Est. week profit ÷ Week sales` — `~`, badged **estimated**.
Empty period → "No repair orders were closed in this period." (tiles suppressed).

## 4.5 The ranked-bar per-RO list (Step B, all-bars as of Step C)
Under the KPI row, a **"Repair orders, ranked by profit"** section — one horizontal bar per
closed RO, **biggest profit first**. Both the KPIs and this list read the **same** per-RO array
(`computeRows` — see §5); there is no second data path.
- **Every RO gets its own bar — no collapse.** (The Step-B 12-row cap + "+ N more small ROs"
  tail summary were removed in Step C at the owner's request.) `$0` ROs sort to the bottom and
  render with an **empty (zero-width) bar** and **`$0 · — · $sale`** — the margin shows **"—"**
  whenever sale is 0 **or** profit is 0 (never a bare 0%, never a divide-by-zero).
- **Each bar:** left = **`RO <ro_number>`** + a subline **`MM-DD · <advisor>`** (the RO's
  `closed_at` day + the `service_writer_id`'s employee name); middle = a track whose **fill
  width ∝ that RO's profit** (scaled to the top RO = 100%, min 2px, `0` when profit ≤ 0);
  right = **`$profit · margin% · $sale`** (profit red when negative).
- **Honesty flags (colour = cost basis):**
  - **green fill / green dot** — the RO's **rebuild (package) line uses a CONFIRMED
    `package_units.unit_cost`** (its `package_unit_id` is in the confirmed-cost map). This is the
    only "real" state.
  - **amber fill / amber dot** — **estimated cost** (the assumed-margin fallback fed the profit).
    Today almost every RO is amber — labor/parts ROs never carry a confirmed unit cost, and
    package lines fall back to 0.55 until confirmed.
  - **red `▲ no advisor stamped — wouldn't earn commission`** — the subline turns red/warn when
    **`service_writer_id` is null** (the RO earns no advisor commission). A legend keyline under
    the bars spells out all three.
- **Long-tail collapse:** ROs at/below **5% of the leader's profit** (or ≤ $0) fold into a single
  line — **`+ N more small ROs (≤ $X each) — <numbers>, and M $0 ROs (<numbers>)`** — with `$0`
  ROs called out separately. The visible list is also hard-capped at **12 bars** (a big quarter
  never prints 40), but always shows at least the top 3.
- **Footnote (`.pro-note`):** the honest "what makes this real" framing — as unit costs are
  confirmed in the Build Sheet **and** jobs get billed on Package lines, ROs flip green and the
  board sharpens unit by unit; the real per-RO parts+labor cost feed is still to come.

## 4.6 The graph toggle — Bars / Donut / Split (Step C)
A small segmented toggle in the section header switches how the **same `computeRows` data** is
drawn. **Bars is the default on every fresh load** (`graphView = 'bars'`, a module var reset on
reload). The keyline legend (§4.5) shows in **Bars only**; the footnote shows in all three.
- **Bars** — the ranked per-RO list above (§4.5).
- **Donut** — *share of the period's profit*. A hand-rolled SVG donut (same stroke-dasharray
  approach as the [[financial-pulse]] donut) with the **top 4 profitable ROs** as coloured
  slices + an **"Other N ROs"** slice for the rest; the centre shows **`~$<total> EST. PROFIT`**.
  Only **positive-profit** ROs contribute (a share slice can't be negative) — so `$0` ROs are
  excluded from the pie and land inside "Other". The legend lists each slice `$profit · %`.
- **Split** — *rebuild vs everything else*. One horizontal bar: a **green** segment =
  **rebuild (Package-line) profit** (`Σ rebuildProfit`, the per-RO sum of `lineGrossProfit` over
  `package` lines) vs a **grey** segment = **everything else** (`total − rebuild`). A caption
  spells both out (`$ · %`); a segment shows its label inline only when wide enough (≥16%). With
  today's data rebuilds read **$0 / 0%** because jobs are billed as `labor`, not Package lines —
  correct and honest, not a bug.
- **No second data path:** every view is a pure function of the one `rows` array. `rebuildProfit`
  is computed in the same `computeRows` pass (one extra `lineGrossProfit` call per package line).

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
- **The ranked list's confirmed (green) state is essentially unreachable today** — only 1 of 50
  units has a confirmed cost and jobs rarely use Package lines, so every bar renders amber, the
  **Split** reads rebuilds $0 / 0%, and the **Donut** slices are all labor/parts profit. All
  correct/honest, not a bug; they shift as data entry moves to Package lines + confirmed costs
  (per the owner's Step-A call — labor stays 100% margin, no COGS haircut).
- **Donut caveat:** the centre total and slice denominator use **Σ positive profit**; if a period
  had negative-profit ROs, the donut total would read slightly under the KPI's `Σ all profit`.
  None today. Bars/Split still show negatives.

## Where it lives in the code
- **`shared/profit-by-ro.js`** — `window.ProfitByRO.mount`; the scoped `.pro-*` styles; the
  period selector; **`computeRows`** (the ONE closed-RO filter → per-RO `{sale, profit,
  rebuildProfit, margin, ro_number, advisor, noAdvisor, basis}`) + `kpisFromRows` (aggregates);
  `kpiRowHtml` (Step A tiles); the section shell **`sectionHtml`** + the graph state `graphView`
  and the three view renderers **`barsHtml`** (all rows, no collapse) / **`donutHtml`** (SVG
  share donut) / **`splitHtml`** (rebuild-vs-rest bar); `buildOpts` (margins + confirmed
  package-cost map); `loadData` (`CommissionEngine.fetchInputs` + the label-only `ro_number`
  map). Slice palette `SLICE_COLORS`/`OTHER_COLOR`.
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
- 2026-08-11 — **Change 1 + Step C.** (1) **Bars now show every closed RO** — dropped the 12-bar
  cap + "+ N more small ROs" tail; `$0` ROs render at the bottom with an empty bar and
  `$0 · — · $sale` (margin "—" when sale or profit is 0, no divide-by-zero). (C) Added a
  **Bars / Donut / Split** graph toggle (§4.6) on the same `computeRows` data — **Bars is the
  default on load**. Donut = SVG share-of-profit (top 4 ROs + "Other N", centre = total est.
  profit, positive-profit only). Split = green rebuild (Package-line) profit vs grey everything
  else, from a new per-RO `rebuildProfit` (Σ `lineGrossProfit` over `package` lines, same pass —
  no second data path). Keyline shows in Bars only; footnote in all. Cost logic unchanged (labor
  stays 100% margin per the owner's Step-A call). Verified in-browser on the owner board: 13 bars
  no tail incl. the $0 RO 5420; Donut top-4 + "Other 6 ROs" summing 100%, centre ~$22.1k; Split
  rebuilds $0/0% vs $22,069/100% (honest — jobs billed as labor); fresh load defaults to Bars; no
  module console errors. Not yet merged — A+B+C ship to prod together on the owner's go.
- 2026-08-11 — **Built Step B — the ranked-bar per-RO list** under the KPI row (§4.5). Refactored
  the Step-A `computeKpis` into a single **`computeRows(range)`** that both the KPIs and the bars
  read (no second data path); `kpisFromRows` derives the tiles. Each closed RO renders a bar
  (width ∝ profit, top = 100%), `RO <ro_number>` + `MM-DD · advisor`, and `$profit · margin% ·
  $sale`. Honesty flags: **green** fill/dot when a package line uses a confirmed unit cost,
  **amber** otherwise, **red** "no advisor stamped" when `service_writer_id` is null. Long tail
  (≤ 5% of the leader, or $0) collapses into "+ N more small ROs (≤ $X each) — …, and M $0 ROs
  (…)"; visible list capped at 12. Added a label-only `ro_number` fetch + advisor-name map to
  `loadData` (profit numbers still come solely from `CommissionEngine.fetchInputs`). Kept the
  owner's Step-A decision: labor stays 100% margin, no COGS haircut. Verified in-browser on the
  owner board — Aug 2–8: 7 bars + "6 more small ROs (≤ $181) — …, and 3 $0 ROs", RO 5503 flagged
  no-advisor, KPI roCount (13) = visible (7) + tail (6), preset switch re-renders, quarter caps
  at 12 bars; no module console errors. Step C (donut/split) NOT built; not merged to prod.
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
