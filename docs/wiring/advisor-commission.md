# How Advisor Commission (gross-profit rollup + payout widgets) is wired

> Doc: `/docs/wiring/advisor-commission.md`
> Last updated: 2026-08-08 — verified vs commit `8c93cee` (merged to main)
> Status: ✅ BUILT on `feat/book-hours` (Hours Engine **Part 2**), behind an owner
> **Advisor Commission** switch (`feature_advisor_commission`, default OFF). Engine +
> both cards verified live in-browser (owner board): week GP `$17,224.80` / 10 ROs →
> commission `$430.62`, pay this week `$1,430.62`; `$5,299.95` of unassigned GP
> correctly not paid. Migration `20260808_advisor_commission.sql` is written but
> **NOT yet applied** (Cris runs SQL by hand) — until then the feature reader fails
> safe to OFF and the engine uses code defaults, so every board looks exactly like today.

## 0. In one line
A per-**advisor** weekly **gross-profit** rollup and the **commission** it drives: the
advisor sees a motivating **"My Commission"** card (leads with commission this month);
the owner and bookkeeper see a **"Commission & Payout"** card (leads with the green
**"Pay this week" = base + this week's commission** — the number the bookkeeper cuts the
check for). Both cards read the **same engine** (`shared/commission-engine.js`) so they
can never disagree.

## 1. Gross profit — the pay basis (locked with the owner 2026-08-08)
Per RO, an advisor's GP = **labor$ + parts-markup$ + package-margin$**:
- **labor$** = labor-line revenue (`quantity × unit_price`) — labor ≈ pure margin.
- **parts-markup$** = `quantity × (unit_price − unit_cost)` (`ro_line_items.unit_cost`).
- **package-margin$** = `unit_price − package unit cost` (`package_units.unit_cost`, per
  unit; a package line is a bundled set price with no per-line cost). qty is 1.
- **Shop Supply / Hazmat / Fee lines are EXCLUDED** (owner decision) — they contribute $0.

**Missing-cost fallback.** Parts/packages captured **no cost** for most rows today (live:
1 of 28 parts lines had a `unit_cost`; packages carry none). So when a parts/package line
has **no real cost**, GP falls back to `price × an assumed-margin fraction`
(`shop_settings.parts_margin_pct` / `package_margin_pct`; code defaults **0.40 / 0.55**).
A **real cost on the line always overrides** the assumed margin. This keeps the number
realistic instead of systematically wrong, and it self-corrects as real costs are entered.

## 2. Attribution — whose GP is it
- An RO's advisor is **`repair_orders.service_writer_id` → `employees.name`** (the printed
  "Service Advisor"; see [[settings]] §3 and `shared/ro-writer.js`). Auto-stamped at RO
  creation, editable.
- **Only `role='advisor'` writers are on the commission plan.** GP written by a
  manager/owner (also eligible RO writers) or by **no one** is tracked as **unassigned —
  never paid** (surfaced on the payout card as an honesty note). Same spirit as Part 1's
  no-tech ROs.
- ⚠ Coverage today is partial: **11 of 33** invoice/closed ROs have a writer stamped
  (auto-stamp began 2026-07-29). The only real advisor in `employees` today is **Josh**;
  **"Manny" is not in the system yet** — add him as a `role='advisor'` employee and he
  flows through automatically with the default plan.

## 3. Payout rules (locked)
- **Rate 2.5% of that advisor's GP. Base $1,000 per full 40-hr week.**
- **WEEKLY-FINAL:** each Sun–Sat week, commission = 2.5% of THAT week's GP, paid that week,
  **final** — no monthly true-up, no clawbacks/chargebacks. "Paid is paid."
- **Month counter = Σ the weeks' commission — informational only.** (Commission is linear in
  GP, so the month figure equals 2.5% × month-to-date GP; the card shows it as info.)
- **Base is a flat $1,000/full week** for now (full-week assumption). **Base accrued this
  month** = `baseWeekly × weeksInMonthToDate` (Sun–Sat weeks overlapping the month so far).
  Time-clock **proration is a later step** (clocked hrs still sampled per Part 1).
- **Per-advisor configurable:** `employees.commission_base_weekly` / `commission_gp_pct`;
  **null → the code default ($1,000 / 2.5% — "Manny's plan")**. Nothing is hardcoded to a
  person. Edited in the owner-only **Advisor Commission** settings pane ([[settings]] §4.3).

## 4. Weeks & bucketing — identical to Part 1
- **Week = Sunday–Saturday, America/New_York** (same as the Manager-board Billed-Hrs
  rollup and the bookkeeping Financial Pulse). `weekWindow()` / `nyDateOf()`.
- **Bucketed by the STABLE set-once `repair_orders.closed_at`** (fallback `updated_at`),
  scoped to `status IN ('invoice','closed')` — the SAME convention as [[flat-rate-hours]]
  §10. A closed RO edited later never shifts its pay to another week.
- Month-to-date and the prior full calendar month come from `monthWindows()`; the advisor
  card's "pace vs last month" compares this month's commission-to-date to last month's total.

## 5. The engine — one pure module both cards read
`shared/commission-engine.js` (mirrors `ro-writer.js`: pure math core, testable under
`node --test`; the browser build assigns `window.CommissionEngine`).
- **Pure:** `lineGrossProfit` / `roGrossProfit` (§1), `advisorPlan` (defaults), `commissionOf`
  (2.5% of GP), the date helpers (§4), and **`compute(input)`** — takes already-fetched
  arrays and returns per-advisor `week` / `month` / `lastMonth` figures + cross-advisor
  `totals` (the owner "Pay this week" line) + an `unassigned` bucket.
- **Impure (browser only):** `fetchInputs(db)` — resilient PostgREST reads that **re-query
  without any not-yet-migrated optional column** (probe cached), so the engine still runs on
  the un-migrated schema using defaults/fallbacks. Never throws.
- **Tests:** `shared/commission-engine.test.js` (18 tests) lock the GP formula, the
  real-cost-overrides-assumed-margin rule, fees excluded, advisor-only payout, the weekly
  math, and the Sun–Sat/NY bucketing (dates pinned via an injected `nowIso`).

## 6. The two cards — one shared module
`shared/commission-cards.js` (regular script → `window.CommissionCards`; self-injects its
`.cmc-*` CSS, light+dark). Reads `window.CommissionEngine` at call time (load-order safe).
- **`renderMine(el, {db, viewerName})`** — the advisor's **My Commission** card (purple):
  leads with **commission this month**; chips = GP written · ROs closed · base accrued ·
  total this month; a pace-vs-last-month line; a "this week so far — pay = base + commission"
  sub. The advisor sees **only themselves** (`r.advisors[viewerName]`).
- **`renderPayout(el, {db})`** — the owner/bookkeeper **Commission & Payout** card (green):
  leads with **Pay this week = base + this week's commission** (per advisor + total); this
  week's GP + ROs; running month commission (info); and a note when unassigned GP exists.

## 7. The switch + where each card mounts (default OFF)
- **Flag:** `shop_settings.feature_advisor_commission` (default false) — the **3rd**
  `FEATURE_FLAGS` entry ([[settings]] §4.1). Owner-only Features toggle; fails safe to OFF
  (missing column / failed read → false), so OFF = boards exactly like today.
- **Advisor board** (`advisor-board.html`): a **My Commission** sidebar view (`#nav-mycommission`
  / `#myCommissionMount`), revealed only when the switch is ON **and** the viewer is an
  advisor. Rendered on identity-resolve, on open, and when settings load
  (`renderMyCommission` / `refreshMyCommissionNav`).
- **Owner board** (`owner-board.html`): a **Commission & Payout** sidebar view
  (`#nav-commission` / `#commissionMount`), revealed when the switch is ON. `renderCommission`;
  nav toggled via `onShopSettingsChanged`.
- **Bookkeeping board** (`bookkeeping-board.html`): the same **Commission & Payout** view,
  rendered from `activateView('commission')`.

## Known gaps & open questions (as of 2026-08-08)
- **GP quality is cost-limited.** Labor is solid; **parts markup and package margin ride the
  assumed-margin fallback** until real costs are entered (`ro_line_items.unit_cost` /
  `package_units.unit_cost`). The check is an estimate on those legs until then — flagged on
  the card copy, not hidden.
- **Advisor coverage is partial** (11/33 ROs have a writer; Manny not yet an employee).
- **Base is a flat full-week $1,000** — no time-clock proration yet (Part 1 samples clocked
  hrs; wiring pay to real punches is a later step).
- **UI-level gate only** — `shop_settings` / `employees` are anon-writable, same posture as
  every setting ([[settings]] §4). The margins/plan are not server-enforced.
- **Comeback/warranty rework** has no explicit commission rule yet (same open item as Part 1).

## Where it lives in the code / schema
- **Engine:** `shared/commission-engine.js` (+ `.test.js`).
- **Cards:** `shared/commission-cards.js` (`.cmc-*` CSS, `renderMine` / `renderPayout`).
- **Schema (additive, unapplied):** `migrations/20260808_advisor_commission.sql` —
  `shop_settings.feature_advisor_commission` / `parts_margin_pct` / `package_margin_pct`;
  `employees.commission_base_weekly` / `commission_gp_pct`; `package_units.unit_cost`.
- **Settings:** `shared/board-settings.js` — `FEATURE_FLAGS` `advisor_commission` entry,
  `renderCommissionPane` / `saveAdvisorPay` / `saveCommissionMargins`, category
  `visible: viewerRole==='owner' && feature_advisor_commission` (see [[settings]] §4.3).
- **Board wiring:** `advisor-board.html` (`renderMyCommission`), `owner-board.html` /
  `bookkeeping-board.html` (`renderCommission`); each loads the engine (ESM →
  `window.CommissionEngine`) + `commission-cards.js`.
- **Consumes:** `repair_orders` (`service_writer_id`, `status`, `closed_at`), `ro_line_items`
  (`line_type`, `quantity`, `unit_price`, `unit_cost`, `package_unit_id`), `package_units`
  (`unit_cost`), `employees` (`role`, plan columns).
- **Related docs:** [[flat-rate-hours]] (Part 1 hours engine + the bucketing this reuses),
  [[ro-line-items]] (`unit_cost`, line types), [[packages]] (`package_units`, package price
  vs pay), [[settings]] (the Features switchboard + the Advisor Commission pane),
  [[manager-board]] (the sibling Part 1 Billed-Hrs rollup), [[financial-pulse]] (the
  bookkeeping board this card also lives on).

## Session change log
- 2026-08-08 — Created (Hours Engine **Part 2**). Built the advisor GP + commission engine
  (`shared/commission-engine.js` + 18 tests) and the two shared cards
  (`shared/commission-cards.js`): advisor **My Commission** + owner/bookkeeper **Commission &
  Payout**, behind a new owner **Advisor Commission** switch (3rd `FEATURE_FLAGS` entry,
  default OFF) with a per-advisor pay pane + assumed-margin fallbacks
  (`renderCommissionPane`). GP = labor + parts markup + package margin (fees excluded), real
  cost overrides assumed margin; commission = 2.5% of that week's GP, base $1,000/full week,
  weekly-final; bucketed by the stable `closed_at`, Sun–Sat NY (reuses Part 1). Migration
  `20260808_advisor_commission.sql` written, **not applied**. Verified live in-browser (owner
  board): both cards reconcile — week GP $17,224.80 / 10 ROs → commission $430.62, pay
  $1,430.62; $5,299.95 unassigned GP not paid; OFF path hides both nav items on all three boards.
