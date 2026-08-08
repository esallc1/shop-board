# How the Financial Pulse is wired

> Doc: `/docs/wiring/financial-pulse.md`
> Last updated: 2026-08-08 — verified vs commit `c6fecec` (branch `feat/bookkeeping-ro-detail`)
> Status: ✅ Verified vs `bookkeeping-board.html`. Realized income reads the `ro_payments`
> ledger (paid-in-full gate, capped at the true invoice total, bucketed by `paid_at`); every
> income view + the income drill-down read that one source. **NEW (Hours-Engine-adjacent, this
> session): a per-RO drill-down (§9)** — the Income / Open-RO lists open a split RO detail with
> the original RO on the left and its matched parts receipts + "profit over parts" on the right,
> behind an owner **Bookkeeping RO Detail** switch (`feature_bk_ro_detail`, default OFF). Expenses
> unchanged. Preview only (not merged).

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

## 8. Clover vs board reconciliation (month-end)
> **reconciliation model — example verified 2026-08-06 against Clover Sales Overview.**
> The dollar figures below are transcribed verbatim from the owner's Clover Sales Overview
> screenshots; they are NOT derived from or checked against the database.

Clover and the board answer **two different questions on purpose** — they are meant to differ,
and the difference is the month-end reconciliation, not a bug to fix.

- **Clover = money COLLECTED at the terminal.** Cash **and** card, and it **includes
  deposits / partial payments on open (not-yet-closed) ROs**.
- **Board "Income (realized)" = recognized REVENUE only** — paid-in-full / closed ROs, capped
  at the RO invoice total, bucketed by `paid_at` (see §2). **Deposits on open jobs are NOT
  income yet** — they sit in the **"Open ROs — future income" pipeline** (§3) until the RO
  closes.
- **The bridge:** for any day/week,
  `(Clover total collected, cash+card) − (board income for the same window)` should equal the
  **deposits / partial payments made on ROs that haven't closed yet**.

### Worked example — Tuesday Aug 4, 2026
- **Clover collected $12,313.21** → Cash **$5,879.85** (1 txn) + Card **$6,433.36**
  (3 txns: MasterCard **$4,060.30**, Visa **$2,373.06**).
- **Board income $6,252.91** → #5511 Khaled cash **$5,879.85** + #6022 Les Cross card
  **$373.06** (the two closed jobs).
- **Gap = $6,060.30 in card = deposits on open jobs:** the ~$4,060 MasterCard engine-swap
  deposit + a $2,000 open-job card payment. **Cash matched to the penny.**

### Nuance to remember
- **Clover is the source of truth for the actual amount collected.** The shop app's
  `ro_payments` may hold a **rounded / tendered** figure (e.g. #5511 recorded **$5,880** in-app
  vs Clover's exact **$5,879.85**). The **income cap at the invoice total absorbs this**, so
  recognized revenue stays correct.
- **Takeaway:** this **confirms the design** (income = paid off + closed); it is **not a
  discrepancy to fix**. A true monthly reconciliation compares **total collected vs recognized
  income**, with **open-job deposits as the bridge**.

## 9. Per-RO drill-down (`feature_bk_ro_detail`, default OFF) — the parts-cost / profit view
A read-only split view that answers "what did we spend on parts for this job, and what's the
profit over those parts." Behind an owner **Bookkeeping RO Detail** feature switch (4th
`FEATURE_FLAGS` entry; see [[settings]] §4.1). **OFF → the Income / Open-RO lists behave exactly
as before** (no row clicks, no detail); the gate is `bkRoDetailOn()` reading
`getShopSettings().feature_bk_ro_detail` (fails safe to false).

### 9.1 Three entry points → one detail
- **Income (realized) modal rows** (`renderDrill`) → open the detail for that paid RO (**final**).
- **"Open ROs — future income" tile** → clickable → a new **open-ROs list modal** (`#finOpenModal`,
  `openOpenList`/`renderOpenList`, same style as the paid list) → rows open the detail
  (**provisional**).
- **Open-RO follow-up list rows** (`renderAging`, `#finAging`) → open the detail (**provisional**).
Row clicks are **delegated** on the stable containers (`finDrillBody` / `finOpenBody` / `finAging`)
so they survive each re-render; each row carries `data-po` and the `fin-rowlink` class only when
the feature is on.

### 9.2 The split detail (`#finRoDetail`, `openRoDetail(po, provisional)` → `renderRoDetail`)
- **LEFT — the FULL RO / invoice document.** As of 2026-08-09 the left pane **embeds the real
  invoice** via the shared builder `window.RoInvoice.buildInvoiceHtml` (the SAME document the
  advisor board prints — see [[ro-invoice]]), scoped under `.roinv .roinv-embed`. `openRoDetail`
  fetches the full RO fields (`customers`, `vehicles`, `service_writer`, complaint/advisory,
  odometer, line items) **plus `ro_payments`**, so a paid closed RO shows the **PAID** state
  (stamp, $0 balance, combined method) inside the panel too. If no `repair_orders` row matches
  the PO (an ALLDATA-only job) the left shows a note and the right still lists receipts.
- **RIGHT — matched parts receipts + profit.** See §9.3. Each receipt row = photo thumbnail
  (signed URL) + description/vendor/date + amount; the thumbnail opens a **lightbox** (`#finPhoto`).
- **Profit line:** `pre-tax ticket subtotal − Parts cost`, shown as **$ and %**, labelled
  **"Profit over parts (excludes labor & overhead) — NOT net profit."** The base is the RO's
  **pre-tax subtotal** (labor + parts + hazmat + supplies + fees) — sales tax is excluded because
  it isn't shop margin (changed 2026-08-09; was the tax-included ticket). For a **provisional**
  (open) RO it adds a `provisional · so far` badge and says parts are partial. Negative profit (a
  mistagged/oversized receipt, or an under-billed ticket) renders in red — surfaced, not hidden.
- **Read-only**: the view only READs; it never writes.

### 9.3 Receipt → RO matching (the linkage, verified live 2026-08-08)
Receipts are the **`invoice_queue`** rows (the bookkeeper's processed parts/expense photos; the
photo is `image_path` in the private **`invoice-images`** bucket, read via `createSignedUrls`).
- **Match key = `invoice_queue.po` (text) == `repair_orders.po`.** PLUS **`invoice_po_lines`**
  rows where `po == RO.po` (a single Parts/Vendor invoice split across multiple jobs; each line's
  `amount` is a cost for its PO, carrying the parent invoice's photo/date). `invoice_po_lines` is
  empty in the data today but supported.
- **What counts toward parts cost:** `counts_as` direction via `countsAsFor()` — **cost adds**
  (`parts_vendor`), **credit subtracts** (`vendor_credit`). **EXCLUDED:** `record_only`
  (`repair_invoice` = the RO's own invoice — it also matches `po=RO.po` but is not a parts cost)
  and **`shop_expense`** (general shop supplies — brake cleaner / ATF, `po` is null anyway).
  `parts_cost = Σ (cost:+amount, credit:−amount)`.
- **⚠ `invoice_queue.po` is FREE TEXT and used inconsistently** (verified live): most
  `parts_vendor` rows carry the **vendor's own invoice number** (`4151833`, `1-812887`, `23056`)
  or a tag (`STOCK`, `KEVIN`, `WC PAID`), and only a subset carry the real shop **RO#** (`5511`,
  `6022`, `6017`, …). This is fine for the design — a receipt whose `po` isn't a real RO# simply
  **doesn't map** (the intended shop-general exclusion) — but it means **coverage is partial**: a
  parts receipt the bookkeeper tagged with the vendor's number won't appear under its RO. The
  detail says so in its empty state rather than implying completeness.

### 9.4 Verified live (2026-08-08, anon read)
PO 6022 (LES CROSS, closed): 2 duplicate `repair_invoice` rows excluded, 1 `parts_vendor` NAPA
$11.25 matched → ticket $373.06, **profit over parts $361.81 · 97%**, photo signed. PO 5474: two
Advance Auto $74.05 receipts both summed **as-is** (visible individually so a dup is spottable) =
$148.10 → 96%. PO 5413: $22.35 ticket vs a $381.74 mistagged receipt → **−$359.39** (red,
surfaced). PO 6009 (open) → provisional. Unmatched PO → "no receipts" empty state.

## Known gaps & open questions (as of 2026-08-08)
- **Per-RO parts matching is only as good as the free-text `po`** (§9.3): receipts tagged with a
  vendor's invoice number (or `STOCK`/tags) don't map to their RO, so a job's parts view can be
  incomplete. A structured RO-link on the receipt (or normalizing `po` at capture) would fix it —
  a later step, flagged not hidden.
- **Core deposits inflate parts cost until the core credit posts** (v1 sums matched receipts as-is;
  cores live in `core_charges` but a core amount baked into a parts invoice counts until its
  `vendor_credit` posts). Core-netting is a later refinement — the detail note says so.
- **Duplicate receipts are summed as-is** — `invoice_queue` has known dupes; the detail lists each
  receipt individually (with date + photo) so a double-scan is visible rather than silently doubled.
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
- **Per-RO drill-down (§9):** `bookkeeping-board.html` — the `#finOpenModal` / `#finRoDetail` /
  `#finPhoto` markup, the `.fin-ro-*` / `.fin-rc-*` / `.fin-rowlink` / `.fin-photo-*` CSS, and in
  the `FinancialPulse` IIFE: `bkRoDetailOn`, `openOpenList`/`renderOpenList`,
  `openRoDetail`/`renderRoDetail`, `openPhoto`/`closePhoto`, the delegated row-click wiring in
  `wire()`, and the clickable pipeline scorecard + `fin-rowlink` rows in `render`/`renderDrill`/
  `renderAging`. Reuses `roTotal`, `countsAsFor`, `createSignedUrls`.
- **Receipts (the match target):** `invoice_queue` (`po`, `invoice_type`, `amount`, `invoice_date`,
  `vendor`, `description`, `image_path`) — `migrations/20260713_invoice_queue.sql`; multi-PO split
  `invoice_po_lines` (`po`, `label`, `amount`, `invoice_queue_id`) + `invoice_types.counts_as` —
  `migrations/20260716_bookkeeping_multiPO_categories_types.sql`; photos in the private
  `invoice-images` bucket.
- **Feature flag:** `shop_settings.feature_bk_ro_detail`
  (`migrations/20260808_bk_ro_detail_flag.sql`, additive, **unapplied**); owner Features toggle via
  the `FEATURE_FLAGS` `bk_ro_detail` entry in `shared/board-settings.js` (see [[settings]] §4.1).
- **Related docs:** `settings.md` (`shop_settings` / `BoardSettings` / the Features switchboard),
  `flat-rate-hours.md` (`completed_jobs` archive caveats), `advisor-commission.md` (the other
  GP-vs-cost view — labor+parts-markup per advisor).

## Session change log
- 2026-08-09 — **Refinement pass (D → C → B).** (D) Profit-over-parts now computes on the RO's
  **pre-tax subtotal**, not the tax-included ticket (sales tax isn't shop margin). (C) The RO-detail
  **LEFT pane now embeds the full real invoice** via the shared builder `shared/ro-invoice.js`
  (`window.RoInvoice.buildInvoiceHtml`, scoped `.roinv .roinv-embed`), replacing the brief summary;
  `openRoDetail` now fetches the full RO fields + `ro_payments`. (B) A **PAID** invoice state landed
  in the shared builder (stamp, per-payment lines, $0 balance, combined method) — so a paid closed RO
  shows PAID in the panel **and** in the advisor print-out (`printRo` is now a thin wrapper over the
  same builder). New docs [[ro-invoice]] + [[payments]]. No schema change. Verified live: 6022 paid →
  PAID doc + $339.04 pre-tax profit; 6025 estimate → unchanged auth/signature.
- 2026-08-08 — **Added the per-RO drill-down (§9), behind `feature_bk_ro_detail` (default OFF).**
  The Income modal rows, a new Open-ROs list modal (from the pipeline tile), and the follow-up
  rows all open a split RO detail: the original RO (left, from `repair_orders` + `ro_line_items`,
  ticket = `roTotal`) and its matched **parts receipts** (right, from `invoice_queue` +
  `invoice_po_lines` where `po == RO.po`, `counts_as` direction, excluding `shop_expense` +
  `record_only`), with photo thumbnails/lightbox from the `invoice-images` bucket and a **"profit
  over parts (excludes labor & overhead)"** line (provisional for open ROs). Read-only; no writes.
  Confirmed the receipt↔RO linkage is the free-text `invoice_queue.po` (partial coverage — vendor
  invoice numbers / tags don't map, the intended shop-general exclusion). Verified live (6022 →
  $361.81 · 97%; 5413 → −$359 surfaced; 5474 dup receipts summed as-is; 6009 open → provisional).
  New migration `20260808_bk_ro_detail_flag.sql` (additive boolean, **unapplied**); 4th
  `FEATURE_FLAGS` entry. `bookkeeping-board.html` + `shared/board-settings.js` + this doc.
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
