# How the Financial Pulse is wired

> Doc: `/docs/wiring/financial-pulse.md`
> Last updated: 2026-08-06 — verified vs commit `e28cbf5`
> Status: ✅ Verified vs the code shipped to main (`bookkeeping-board.html`). §4 week
> windows changed from rolling-7-day to **calendar Sun–Sat** weeks (top "THIS WEEK" card +
> Financial Pulse "This week"/"Last week" presets, still matched to the penny). The income
> drill-down is NOT on main yet — it stays on its own branch pending the ro_payments rebuild.

## 0. In one line
A read-only dashboard section on the Bookkeeping Board's **Overview** tab that shows
**realized income** and the **future-income pipeline** over an editable date range, plus a
trend chart, an income-vs-expenses net, an income breakdown donut, and an open-RO
follow-up list. Every figure is derived from the board's own Supabase ledger — **it never
writes**, and it is **not** QuickBooks.

## 1. Where it lives on screen
- Inside `#view-overview`, between the existing quick-glance cards (`#ovCards`) and the
  Core Bank card. Additive: the alert, the four cards, and Core Bank are untouched.
- Markup: the `#finPulse` card (range control + `#finScorecards` + `#finTrend` /
  `#finIncExp` / `#finDonut` panels + `#finAging`).
- Logic: the `FinancialPulse` IIFE (single `render()` off cached data; charts are
  hand-rolled inline SVG, matching the rest of the app — no chart library).

## 2. Realized income — the money-in number
- **Source: `invoice_queue` rows where `invoice_type = 'repair_invoice'` and
  `status = 'processed'`.** This is bookkeeping's own ledger of every repair invoice —
  both legacy **ALLDATA** jobs and CrisData ROs, because Daiana snaps every repair
  invoice regardless of which system produced it. Amount = `amount`, bucket date =
  **`invoice_date`**.
- **Why this and not `ro_payments` / `completed_jobs`:**
  - `ro_payments` (cash-received, with a real `paid_at`) is **barely used** — 4 rows live
    on 2026-08-05 — so it under-reports badly.
  - `completed_jobs.total_amount` is **CrisData-only** (~22 non-zero rows), has known
    **duplicate rows** (two archive writers, see `flat-rate-hours.md` §6.4), and only
    `picked_up_at` as a date (lags actual completion).
  - `repair_invoice` is the **same table the expense cards already read**, so Income and
    Expenses reconcile in one ledger, it has a clean `invoice_date`, and it covers the
    ALLDATA jobs that never became `repair_orders`.
- **Assumption (pay-and-take shop):** an *invoiced* repair is a *completed, paid* sale, so
  "realized" = invoiced. There is no separate paid/settled flag to gate on. `repair_orders`
  has **no completion/closed/paid timestamp** (confirmed across all migrations), which is
  the other reason realized income is bucketed by `invoice_date` here, not off the RO.

## 3. Future income — the pipeline number (a snapshot of NOW)
- **Source: `repair_orders` where `status <> 'closed'`** (i.e. `estimate` / `ro` /
  `invoice`). This is CrisData-only by nature — ALLDATA has no RO records. Estimates are
  included (they're open work); the aging list shows each RO's stage so estimates are
  distinguishable.
- **Per-RO total is computed client-side from `ro_line_items`**, matching the RO builder's
  `recalcTotals` (`advisor-board.html`): `Σ(quantity × unit_price)` over all lines **plus**
  `taxable_subtotal × tax_rate`, where `tax_rate` comes from `shop_settings` via
  `BoardSettings.getShopSettings()` (fallback `0.065`) and tax is skipped when the RO's
  customer is `tax_exempt`. Fetched with one nested PostgREST select
  (`repair_orders(...customers(...),ro_line_items(...))`).
- **This card deliberately ignores the date range** — a pipeline is always "as of today."
  It's labelled `as of now`.

## 4. The date-range control
- Presets: This week, Last week (**default**), This month, Last month, This quarter,
  Last quarter, Custom (two date pickers).
- **Windows MATCH the top Overview cards** (`renderOverviewCards`) so the two "this week" /
  "this month" figures never disagree on screen:
  - **Week = calendar week, Sunday → Saturday.** "This week" = the calendar week that
    **contains today**, `[Sunday .. Saturday]`, and is **not clipped to today** — e.g. viewed
    on Thu Aug 6 it is `Sun Aug 2 .. Sat Aug 8` no matter which weekday it's opened on. "Last
    week" = the prior calendar week, `[Sunday .. Saturday]` (e.g. `Sun Jul 26 .. Sat Aug 1`).
    The top "THIS WEEK" card uses the **same** `[Sunday .. Saturday]` window (via
    `weekStart`/`weekEnd` in `renderOverviewCards`), so the card and the Pulse "This week"
    Parts/Vendor + Shop Expenses agree to the penny.
  - **Month / quarter = calendar, to-date.** "This month" = `[1st of this month .. today]`;
    "This quarter" = `[1st of this quarter .. today]` (the top card matches on `YYYY-MM`; with
    no future-dated invoices the sums are identical to the penny). "Last month" / "Last
    quarter" = the full previous calendar month / quarter.
  - **Custom** parses the two `YYYY-MM-DD` inputs (swapped if from > to).
- The "Showing X – Y" subtitle reflects the **actual** window each preset produces (so
  "This week" shows the full calendar week, e.g. *Aug 2 – Aug 8*, including days after today).
- Changing the range **re-renders only the range-driven pieces** (Income scorecard, trend,
  income-vs-expenses, donut) from already-cached data — **no refetch**. The pipeline card
  and aging list never change with the range.
- All range math is **local dates formatted `YYYY-MM-DD`** so it compares directly against
  the string `invoice_date` values.

## 5. The visuals
- **Income trend** (`#finTrend`) — SVG bars of realized income, auto-bucketed by the span:
  ≤14 days → daily, ≤92 → weekly, else monthly.
- **Income vs Expenses** (`#finIncExp`) — two SVG bars (Income vs total Expenses) plus a
  numeric readout: Income, − Parts/Vendor, − Shop Expenses, **Net = Income − Expenses**.
  Expenses reuse the board's existing `countsAsFor` spend math verbatim (`parts_vendor`
  and `shop_expense` buckets; `vendor_credit`/`credit` subtracts; `repair_invoice` is
  `record_only` and excluded), so the numbers reconcile with the four cards above.
- **Income breakdown** (`#finDonut`) — realized income split by **job category**, mapped
  `repair_invoice.po → completed_jobs.job_category` (`Rebuild` / `Gen Auto` / `Diag`; any
  unmatched or uncategorized PO → **Other**). Slices sum exactly to the Income scorecard.
- **Open-RO follow-up list** (`#finAging`) — every open RO, oldest first: RO #, customer,
  stage badge, computed amount, age in days (from `created_at`; ≥14d flagged red).

## Known gaps & open questions (as of 2026-08-05)
- **Realized income = invoiced, not settled.** If the shop ever starts recording partial
  deposits / unpaid pickups consistently, "realized" may want to switch to a paid signal
  (`ro_payments`), which is currently too sparse to trust.
- **Donut "Other" can be large** — repair invoices whose `po` isn't in `completed_jobs`
  (mostly legacy ALLDATA) all land in Other. It's honest, not a bug.
- **Pipeline is CrisData-only** — open work still living purely in ALLDATA isn't counted,
  because it has no `repair_orders` row.
- **`invoice_date` trust** — one live `repair_invoice` row has a 2016 OCR date; the range
  filter naturally excludes such outliers from any recent range.

## Where it lives in the code / schema
- **UI + logic:** `bookkeeping-board.html` — `#finPulse` markup, the `.fin-*` CSS, the
  `FinancialPulse` IIFE, and the two added reads in `loadOverview()` (open ROs + the
  `completed_jobs(po,job_category)` map; `po` also added to the processed-invoice select).
- **Income / expenses:** `invoice_queue` (`invoice_type`, `amount`, `invoice_date`, `po`,
  `status`) — `migrations/20260713_invoice_queue.sql`, `20260714_invoice_queue_date.sql`,
  `20260716_bookkeeping_multiPO_categories_types.sql`; classification via `invoice_types`
  (`counts_as`) and the board's `countsAsFor()`.
- **Pipeline:** `repair_orders` (`status`, `created_at`, `customer_id`, `vehicle_id`) +
  `ro_line_items` (`quantity`, `unit_price`, `taxable`) + `customers.tax_exempt` —
  `migrations/20260716_ro_foundation.sql`, `20260717_ro_status_closed.sql`; tax from
  `shop_settings` (`migrations/20260716_shop_settings.sql`) via `shared/board-settings.js`.
- **Donut category map:** `completed_jobs` (`po`, `job_category`) —
  `migrations/20260711_completed_jobs.sql`.
- **Related docs:** `flat-rate-hours.md` (why `ro_payments`/`completed_jobs` are
  unreliable), `settings.md` (`shop_settings` / `BoardSettings`).

## Session change log
- 2026-08-06 — Reverted the week presets from rolling-7-day back to **calendar Sunday–Saturday**
  weeks, in BOTH the top "THIS WEEK" card (`renderOverviewCards`) and the Financial Pulse
  "This week"/"Last week" presets (`rangeFor`). "This week" = the calendar week containing
  today, `[Sunday .. Saturday]`, not clipped to today; "Last week" = the prior calendar week.
  Month/quarter presets unchanged. Both windows still matched to the penny. §4 reworded.
  `bookkeeping-board.html` + this doc only.
- 2026-08-05 — Created with the Financial Pulse section on the Bookkeeping Board Overview
  tab. Realized income from `repair_invoice` rows (bucketed by `invoice_date`), open-RO
  pipeline computed from `ro_line_items`, trend / income-vs-expenses / category donut /
  aging list, all driven by an editable date range (pipeline + aging stay as-of-now).
  Additive only; no schema changes; expenses reuse the existing `countsAsFor` math so the
  numbers reconcile with the existing cards.
- 2026-08-05 — Reworked the range presets to MATCH the top Overview cards: week is a
  **rolling** last-7-days window (`[today−6 .. today]`, "last week" = the prior 7-day block),
  month/quarter are **calendar** to-date. Previously the section used Sunday-start calendar
  weeks, so its "this week" / "this month" disagreed with the top cards; now they reconcile
  to the penny. Updated §4 to describe the shipped windows. `bookkeeping-board.html` +
  this doc only.
