# How the RO / invoice document builder is wired

> Doc: `/docs/wiring/ro-invoice.md`
> Last updated: 2026-08-09 — verified vs commit `455693f` (merged to main)
> Status: ✅ BUILT + verified this session. `printRo` was extracted into a shared PURE builder
> `shared/ro-invoice.js` (+ `ro-invoice.test.js`, 11 tests). Two consumers render the identical
> document: the advisor board prints it; the bookkeeping RO-detail LEFT pane embeds it. Verified
> live: paid RO 6022 → PAID document (stamp, $0 balance, combined method); estimate 6025 →
> unchanged authorization + signature layout.

## 0. In one line
One shared function builds the customer-facing **Estimate / Repair Order / Invoice / Receipt**
document as an HTML string — pure (no DOM, no window, no globals) — so the **advisor print-out**
and the **bookkeeping RO-detail panel** can never diverge, and a **paid** invoice finally shows a
PAID state instead of a blank signature line.

## 1. The builder — `shared/ro-invoice.js`
- ESM module; the browser build assigns **`window.RoInvoice`**. PURE math/markup core so
  `ro-invoice.test.js` runs it under `node --test`. Inlines its own `esc` / `num` / `money` /
  `fmtPhone` (mirror of `shared/format.js`) / `serviceWriterName` — **no external globals**.
- **`buildInvoiceHtml(opts)`** → the `<div class="inv">…</div>` **fragment**.
- **`buildPrintDoc(opts)`** → a full standalone `<!doctype html>` doc = `@page`/reset +
  `INVOICE_CSS` + `<div class="roinv">` + the fragment + `onload="window.print()"`.
- **`INVOICE_CSS`** → the document CSS, **every rule scoped under `.roinv`** (a test asserts it),
  so it's safe to inject into any board. The print doc wraps in `.roinv`; the embed adds
  `.roinv-embed` (`.inv` → `max-width:100%`).
- **`opts` = `{ ro, lines, settings, payments, receipt, methodLabel }`:**
  - `ro` — a `repair_orders` row with embedded `customers`, `vehicles`, `service_writer` (+
    `status`, `ro_number`, `complaint`, `advisory_notes`, `technician`, `odometer_in`,
    `miles_out`, `closed_at`).
  - `lines` — `ro_line_items[]` (`line_type`, `description`, `part_number`, `quantity`,
    `unit_price`, `taxable`).
  - `settings` — `shop_settings` (`tax_rate`, `show_tech_on_ro`, shop-profile fields, legal/MV).
  - `payments` — `ro_payments[]` (drives the PAID state; see §3).
  - `receipt` — `{ amount, description, method, receiptNumber, estimateNumber }` → receipt mode.
  - `methodLabel(value)` — optional; maps a payment method value to a label (boards pass
    `BoardSettings.paymentMethodLabel`; default title-cases).

## 2. Document identity + the three bodies
- **Label** from `ro.status`: `estimate → ESTIMATE`, `ro → REPAIR ORDER`, `invoice`/`closed → INVOICE`
  (`receipt → RECEIPT`). Same header/customer/vehicle layout throughout; only the body differs:
  - **RECEIPT** (`opts.receipt`) — the quick diag-fee one-liner (Subtotal / Balance Due / Paid).
  - **PAID** (§3) — the work/labor/parts/totals tables **+ a PAID block** replacing auth/signature.
  - **INVOICE** (everything else: estimate / ro / unpaid invoice) — the work tables **+ the
    Authorization + customer-signature block**, byte-for-byte the original layout.
- **Selection:** `isReceipt ? receiptBody : (isPaid ? paidBody : invoiceBody)`. The `invoiceBody`
  path (estimate / ro / unpaid) is **unchanged** from the pre-extraction printout.

## 3. The PAID state (customer-facing correctness fix)
- **`isPaid = status ∈ {invoice, closed} AND invoiceTotal > 0 AND Σ payments ≥ invoiceTotal − 0.005`.**
  An estimate is **never** paid (status gate); a partial payment stays unpaid (keeps the auth block).
- **The PAID block** (modeled on the existing diag `receiptBody`) **replaces** the "Original
  estimate total / Method ☐ / signature" block: a green **PAID** stamp, one line per payment
  (`Paid — <method> (<date>) $amt`), **Balance Due $0.00**, and a note "Paid in full on
  `<closing paid_at, else ro.closed_at>` · `<combined methods, e.g. Cash + Card>`. No signature
  required." A small **PAID** tag also appears in the doc header.
- **Fails safe:** a paid-off RO with no `ro_payments` rows (e.g. ALLDATA-era) → `isPaid=false` →
  it prints the normal invoice, exactly like today. So the fix only *adds* a PAID state where
  real payment data exists; it never regresses an untracked RO. **No feature switch** — it's a
  data-gated correctness fix (see the session report for the rationale).

## 4. The two consumers
- **Advisor board — `printRo(receipt)`** (`advisor-board.html`): a **thin wrapper** — gathers
  `currentRo` / `currentLines` / `shop_settings` / `currentPayments` (+ `receipt` for diag mode)
  → `window.RoInvoice.buildPrintDoc(...)` → `window.open` + `document.write`. No visual change to
  the estimate/RO/unpaid printout; paid ROs now print the PAID document.
- **Bookkeeping board — the per-RO detail LEFT pane** (`bookkeeping-board.html`, gated by
  `feature_bk_ro_detail`; see [[financial-pulse]] §9): injects `INVOICE_CSS` once, then embeds
  `<div class="roinv roinv-embed">${buildInvoiceHtml(...)}</div>` — the **full real invoice**
  instead of the old brief summary. It fetches the full RO fields + `ro_payments` for this (so a
  closed/paid RO shows PAID inside the panel too). The RIGHT pane keeps receipts + profit-over-parts.

## Known gaps & open questions (as of 2026-08-09)
- **Embed width** — the invoice is designed for a 7.5in page; in the bookkeeping split it renders
  in a ~1.5fr column (modal widened to 1140px) with `overflow-x:auto`. Fine on desktop; tight on
  a phone (the modal isn't a mobile target for the bookkeeper).
- **`printRo` still reads `currentPayments`** (module global) for the paid state — correct while
  the RO detail is open (payments are loaded there). Printing a paid RO whose payments haven't
  loaded would fall back to the unpaid layout (fails safe).
- **`esc` now also escapes `&`/`"`/`'`** (the old inline board `esc` did only `<`/`>`); output
  renders identically in HTML text — no visual change, slightly more correct.

## Where it lives in the code
- **Builder:** `shared/ro-invoice.js` (`buildInvoiceHtml`, `buildPrintDoc`, `INVOICE_CSS`) +
  `shared/ro-invoice.test.js`.
- **Advisor wrapper:** `advisor-board.html` `printRo` + the `import * as RoInvoice` module tag.
- **Bookkeeping embed:** `bookkeeping-board.html` `openRoDetail` (full RO + payments fetch) /
  `renderRoDetail` (LEFT pane embed + pre-tax profit) + the `import * as RoInvoice` module tag.
- **Related docs:** [[payments]] (the `ro_payments` the PAID state reads), [[financial-pulse]]
  (§9 the bookkeeping consumer), [[ro-line-items]] (the lines the totals sum; package fold-in),
  [[packages]] (package lines print under Parts), [[settings]] (shop profile + `payment_methods`).

## Session change log
- 2026-08-09 — Created. Extracted `advisor-board.html` `printRo` into the shared PURE builder
  `shared/ro-invoice.js` (`buildInvoiceHtml` / `buildPrintDoc` / scoped `INVOICE_CSS`; 11 tests).
  Refactored `printRo` to a thin wrapper (no visual change to the estimate/unpaid printout).
  Added the **PAID** body (stamp, per-payment lines, $0 balance, combined method, date paid)
  replacing the auth/signature when `status∈{invoice,closed}` and paid in full. Embedded the same
  builder in the bookkeeping RO-detail LEFT pane (full invoice, incl. PAID). Verified live: 6022
  paid → PAID doc; 6025 estimate → unchanged auth/signature.
