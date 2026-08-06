# How the Financial Pulse is wired

> Doc: `/docs/wiring/financial-pulse.md`
> Last updated: 2026-08-06 — verified vs commit `0168264`
> Status: ✅ Verified vs the code on branch `feat/bookkeeping-income-from-payments`
> (`bookkeeping-board.html`). **Realized income was repointed from `invoice_queue` to the
> `ro_payments` ledger** (paid-in-full gate, capped at the true invoice total, bucketed by
> `paid_at`); every income view + the income drill-down now read that one source. Expenses
> are unchanged. Not yet on main — pending owner sign-off.

## 0. In one line
A read-only dashboard section on the Bookkeeping Board's **Overview** tab that shows
**realized income** (money from **paid-off ROs**) and the **future-income pipeline** over an
editable date range, plus a trend chart, an income-vs-expenses net, an income breakdown
donut, and an open-RO follow-up list. Every figure is derived from the board's own Supabase
ledger — **it never writes**, and it is **not** QuickBooks.

## 1. Where it lives on screen
- Inside `#view-overview`, between the existing quick-glance cards (`#ovCards`) and the
  Core Bank card. Additive: the alert, the four cards, and Core Bank are untouched.
- Markup: the `#finPulse` card (range control + `#finScorecards` + `#finTrend` /
  `#finIncExp` / `#finDonut` panels + `#finAging`) plus the income drill-down modal
  (`#finDrillModal`), which sits just after the `#finPulse` card.
- Logic: the `FinancialPulse` IIFE (single `render()` off cached data; charts are
  hand-rolled inline SVG, matching the rest of the app — no chart library).

## 2. Realized income — the money-in number (paid-off ROs)
- **Source: `ro_payments`, the Advisor "Payments" ledger, joined to `repair_orders` by the
  `repair_order_id` FK.** Income is the money from **cars that are paid off**, recorded in
  the app when the customer pays. (Older weeks that predate in-app payment capture will read
  low **on purpose** — that is accepted, not a bug.)
- **Paid-in-full gate.** Income is recognized for an RO **only** when it is fully paid:
  `Σ(ro_payments.amount for the RO) ≥ ro_total − 0.005`. Partial payments / deposits are
  **not** counted as income (there are none in the data today, but the gate is built anyway).
- **Amount = the true invoice total (`ro_total`), never the cash tendered.** Because
  `ro_payments.amount` stores **cash tendered** (uncapped — the app inserts the typed amount
  verbatim, see `recordPayment` in `advisor-board.html`), booking the raw payment would count
  a customer's **change** as revenue. Capping at `ro_total` prevents that — e.g. RO #5494
  counts **$192.75**, not the **$200** tendered; RO #5511 counts **$5,879.85**, not **$5,880**.
- **`ro_total` reproduces the RO builder's `recalcTotals` exactly** (`roTotal()` in this
  file, shared with the pipeline card): `Σ(quantity × unit_price)` over all `ro_line_items`
  **plus** `taxable_subtotal × tax_rate`, tax skipped when the RO's customer is `tax_exempt`.
  `tax_rate` is the **live** value from `shop_settings` via `BoardSettings.getShopSettings()`
  (never hardcoded; fallback `0.065` only if the settings row hasn't loaded).
- **Bucket date = the `paid_at` of the CLOSING (latest) payment**, converted to the shop's
  local date in **America/New_York** (`nyDate()` → `en-CA` `YYYY-MM-DD`). That is the
  "paid-and-closed" date the whole income half buckets by.
- **One record per paid-in-full RO** (`buildPaidIncome()`): `{ po, customer, category, date,
  amount, methods[] }`. `customer` = `repair_orders → customers.name`; `category` = the RO's
  `completed_jobs.job_category` (donut); `methods` = the distinct `ro_payments.method`s.
  **Legacy ALLDATA jobs have no `ro_payments` row, so they never appear** (no blank rows).
- **Coverage note (clean switch, no hybrid):** `ro_payments` is **CrisData-only**. We do
  **not** blend in `invoice_queue` — income comes from the Payments ledger going forward.

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
  income-vs-expenses, donut, and the drill-down if open) from already-cached data — **no
  refetch**. The pipeline card and aging list never change with the range.
- Range math is **local dates formatted `YYYY-MM-DD`**. Income compares against each RO's
  **`paid_at` date in America/New_York** (`nyDate()`); expenses compare against
  `invoice_date`. The board runs in-shop (Eastern), so the local range bounds and the NY
  paid-date buckets line up.

## 5. The visuals
- **Every income view reads the one `incomeRows(range)` list** (paid-in-full ROs whose
  closing `paid_at` falls in the range), so the scorecard, trend, donut, income-vs-expenses
  income bar, and the drill-down **always reconcile to the same number** by construction.
- **Income trend** (`#finTrend`) — SVG bars of realized income bucketed by each RO's closing
  `paid_at` date, auto-granularity by span: ≤14 days → daily, ≤92 → weekly, else monthly.
- **Income vs Expenses** (`#finIncExp`) — two SVG bars (Income vs total Expenses) plus a
  numeric readout: Income, − Parts/Vendor, − Shop Expenses, **Net = Income − Expenses**.
  **Expenses are UNCHANGED** — they still reuse the board's existing `countsAsFor` spend math
  verbatim over `invoice_queue` (`parts_vendor` and `shop_expense` buckets;
  `vendor_credit`/`credit` subtracts; `repair_invoice` is `record_only` and excluded), so the
  numbers reconcile with the four cards above. Only the **income** bar changed source.
- **Income breakdown** (`#finDonut`) — realized income split by **job category**, using each
  paid RO's `po → completed_jobs.job_category` (`Rebuild` / `Gen Auto` / `Diag`; any unmatched
  or uncategorized PO → **Other**). Slices sum exactly to the Income scorecard.
- **Open-RO follow-up list** (`#finAging`) — every open RO, oldest first: RO #, customer,
  stage badge, computed amount, age in days (from `created_at`; ≥14d flagged red).

## 6. Income drill-down — the paid-RO list for QuickBooks entry
- **The Income (realized) scorecard is clickable** (green "Tap to list paid ROs →" hint). It
  opens a modal (`#finDrillModal`) listing **every paid-in-full RO that composes the Income
  number for the selected range** — the data-entry aid for hand-keying into QuickBooks.
- **Same source, same list as the card:** the rows are exactly `cur.incRows`
  (`incomeRows(currentRange)`), sorted by closing date then RO #. Because the card and the
  list read the identical records, **the modal's bottom total always equals the scorecard** —
  a `✓ matches card` / `⚠ mismatch` marker makes the reconciliation visible (a mismatch would
  be a bug).
- **Columns:** RO # (`po`), Customer (`repair_orders → customers.name`), Date paid (closing
  `paid_at`), Amount (**capped `ro_total`**), Paid (the `ro_payments.method`(s), joined with
  `+` when an RO was paid by more than one method). No blank Customer/Paid rows: every row is
  a real paid RO, so both fields are native to the record.
- **Follows the range control:** opening after changing the range shows that range's paid ROs;
  if the modal is already open when the range changes, it refreshes in place. Closes on ✕,
  backdrop click, or Esc.

## 7. The Payments ledger (`ro_payments`) — how income is wired to it
- **What it is:** one row **per payment** against an RO (deposits + split payments = multiple
  rows). Record-only — the app does not process cards; Advisors tap "Record payment" on the
  RO (`recordPayment`, `advisor-board.html`). Migration: `migrations/20260718_ro_payments.sql`.
- **Columns used:** `repair_order_id` (hard FK → `repair_orders`), `amount`, `method`,
  **`paid_at`** (timestamptz — the payment-date column income buckets by), `po` (mirror text
  key). The Pulse reads them via one nested PostgREST select that embeds the RO, its customer,
  and its line items: `ro_payments(... repair_orders(po,status,customers(name,tax_exempt),
  ro_line_items(quantity,unit_price,taxable)))`.
- **Join keys:** income joins `ro_payments → repair_orders` by **`repair_order_id`** (the
  hard FK, preferred over the `po` text). `ro_total` comes from that RO's `ro_line_items`
  (matches `recalcTotals`); customer from `repair_orders.customer_id → customers.name`.
- **Change / overpayment behavior:** `ro_payments.amount` is **cash tendered, not applied** —
  `recordPayment` inserts the typed amount uncapped, so a payment can exceed the invoice
  (live data: RO #5494 $200 vs $192.75, RO #5511 $5,880 vs $5,879.85 — ~$7.40 of change across
  the data today). The Pulse **never** books tendered cash; it books the capped `ro_total`, so
  change can never count as revenue.
- **Partials / deposits:** an RO with `Σ payments < ro_total` is **excluded** entirely (not
  paid off). When it later reaches paid-in-full, it's counted once, at the capped `ro_total`,
  on its closing `paid_at` — no double-counting.
- **ALLDATA dedupe:** irrelevant to the dollars — `ro_total` comes from line items and
  payments link by `repair_order_id`, so a duplicated customer only risks a name label, never
  a doubled amount.

## Known gaps & open questions (as of 2026-08-06)
- **Income is CrisData-only, by design.** `ro_payments` only exists for in-app ROs, and the
  team started recording payments in-app the week of 2026-08-02. **Weeks before that read
  low on purpose** — this is the accepted trade-off of the clean switch (no `invoice_queue`
  hybrid). ALLDATA-only jobs never appear in income.
- **Bucketing assumes the board runs on Eastern time.** Income buckets by `paid_at` in
  America/New_York; the range presets use the viewer's local calendar day. In-shop these
  align; a viewer in another timezone could see an edge-of-week payment shift by a day.
- **Donut "Other" can be large** — paid ROs whose `po` isn't in `completed_jobs` land in
  Other. Honest, not a bug.
- **Pipeline is CrisData-only** — open work still living purely in ALLDATA isn't counted,
  because it has no `repair_orders` row.

## Where it lives in the code / schema
- **UI + logic:** `bookkeeping-board.html` — `#finPulse` markup, the `#finDrillModal` markup,
  the `.fin-*` / `.fin-drill-*` CSS, the `FinancialPulse` IIFE (`buildPaidIncome`, `nyDate`,
  `incomeRows`, `roTotal`, `renderDrill`), and the `loadOverview()` reads (open ROs; the
  `completed_jobs(po,job_category)` map; and the `ro_payments(...repair_orders(...))` income
  read).
- **Income:** `ro_payments` (`repair_order_id`, `amount`, `method`, `paid_at`, `po`) joined to
  `repair_orders` — `migrations/20260718_ro_payments.sql`; `ro_total` from `ro_line_items` +
  `shop_settings.tax_rate` (`migrations/20260716_ro_foundation.sql`,
  `20260716_shop_settings.sql`) via `shared/board-settings.js`.
- **Expenses (unchanged):** `invoice_queue` (`invoice_type`, `amount`, `invoice_date`,
  `status`) — `migrations/20260713_invoice_queue.sql`, `20260714_invoice_queue_date.sql`,
  `20260716_bookkeeping_multiPO_categories_types.sql`; classification via `invoice_types`
  (`counts_as`) and the board's `countsAsFor()`.
- **Pipeline:** `repair_orders` (`status`, `created_at`, `customer_id`) + `ro_line_items`
  (`quantity`, `unit_price`, `taxable`) + `customers.tax_exempt` —
  `migrations/20260716_ro_foundation.sql`, `20260717_ro_status_closed.sql`.
- **Donut category map:** `completed_jobs` (`po`, `job_category`) —
  `migrations/20260711_completed_jobs.sql`.
- **Related docs:** `settings.md` (`shop_settings` / `BoardSettings`), `flat-rate-hours.md`
  (`completed_jobs` archive caveats).

## Session change log
- 2026-08-06 — **Repointed realized income from `invoice_queue` to the `ro_payments` ledger**
  (clean switch, no hybrid). Income is now recognized per **paid-in-full RO**
  (`Σ payments ≥ ro_total − 0.005`), booked at the **capped `ro_total`** (never the tendered
  cash, so change can't count), bucketed by the **closing `paid_at`** date in
  America/New_York. Every income view (scorecard, trend, income-vs-expenses income bar, donut)
  and the **rebuilt income drill-down** (per paid RO: RO #, customer, date paid, capped amount,
  method(s)) read one `incomeRows(range)` list, so they reconcile by construction. Expenses
  untouched. Added the `ro_payments(...repair_orders(...))` read to `loadOverview`; folded in
  and reworked the earlier drill-down (was `6c12505`, invoice_queue-based). `bookkeeping-board.html`
  + this doc only; no schema changes. Verified: This week (Aug 2–8) = **$12,250.58 / 4 ROs**.
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
