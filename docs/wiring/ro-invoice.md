# How the RO / invoice document builder is wired

> Doc: `/docs/wiring/ro-invoice.md`
> **2026-09-19 — §5 added: "Warranty given"** (`repair_orders.warranty_terms`, printed above the
> signature / PAID block) **+ line breaks now print in Advisory notes and the Warranty block.**
> Branch `feat/ro-warranty-terms`, unmerged. §5, the `workAndTotals`/`bodyHtml` order and the CSS
> re-checked against `shared/ro-invoice.js` this session; the rest carried.
> **2026-09-18 — §2a added: fee lines print BY NAME in the totals box** (branch
> `feat/invoice-fee-by-name`, UNMERGED — staging only). §2a, Known gaps and the change log
> re-checked against `shared/ro-invoice.js` this session; the rest carried from 2026-09-11.
> Previously: 2026-09-11 — verified vs commit `0fcc863` (the commit this doc ships with)
> Status: ✅ BUILT + verified. `printRo` was extracted into a shared PURE builder
> `shared/ro-invoice.js` (+ `ro-invoice.test.js`, 11 tests). **THREE** consumers now render the
> identical document: the advisor board prints it, the bookkeeping RO-detail LEFT pane embeds it,
> and (2026-09-11) that same panel PRINTS it for QuickBooks. Re-verified 2026-09-11 by generating
> the document from HEAD's builder and the working tree's and diffing: byte-identical across all
> four stages + receipt mode, and the bookkeeping print is byte-identical to the advisor print.

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

## 2a. The totals box — what is itemised, what is lumped
The work tables list only **labor** and **parts** (package lines fold into Parts). Everything else
is shown in the **totals box** (`workAndTotals`), in this order:

| Row | Source | How it's labelled |
|---|---|---|
| Labor / Parts | `catSum('labor')` / `catSum('parts') + catSum('package')` | fixed labels |
| Hazmat \* / Shop Supplies \* | `catSum('hazmat')` / `catSum('shop_supply')` | fixed labels, **lumped on purpose** (flat shop charges — the footnote says so) |
| **one row per `fee` line** | `feeRows` — that line's `quantity × unit_price` | **its stored `description`, exactly as written** (HTML-escaped); blank → `Fee` |
| Taxes (rate% / exempt) | `T.tax` | fixed label |
| **Live card fee** (switch ON) | `T.cardFee` — `card_fee_pct × (lines + tax)` | `Card processing fee (4.00%)` (from the rate); "— rate unavailable" if the rate can't load. After Taxes because it's charged on the taxed total. [[card-fee]] |
| Invoice Total | `T.total` from **`shared/ro-totals.js`** (`computeRoTotals`) — lines + tax + live fee | fixed label |

The totals math is **not** in this file any more: `T = computeRoTotals(lines, …)` is the same
calculator every other surface uses. With the switch off the document is byte-identical to the
pre-switch builder (checked on 54 real sandbox ROs, 2026-09-18).

- **Why by name:** the card fee (then `addCardFee`, [[ro-line-items]]; a live switch since
  2026-09-18, [[card-fee]]) was stored as an ordinary
  `line_type='fee'` row whose `description` reads e.g. `Card processing fee (4.00%)`. Until
  2026-09-18 the builder summed every fee line into one unnamed **"Fees"** row, so the customer
  saw a charge with no explanation. Nothing marks a line as *the card fee* specifically — so the
  rule is simply "every fee line prints by its own description", which also names any hand-added
  Fee line and the older ALLDATA-era `CARD PROCESSING FEE` lines (their uppercase wording is kept).
- **Display only.** `feesTotal` still feeds `invoiceTotal` exactly as before; a fee line marked
  `taxable` is still taxed through `taxableBase`; nothing is written. Proven on the sandbox
  2026-09-18 by rendering the 10 fee ROs + 1 no-fee RO with the old (`8700ed6`) and new builders:
  identical Invoice Total, Taxes, Balance and PAID state on all 11, and a line-diff showing the
  fee row's label as the **only** change (the no-fee RO byte-identical).
- **One behaviour difference:** the old single row was shown only when the fee **sum** was
  `> 0`. Each fee line now always gets its row — so a `$0.00` or negative fee line (none exist
  today) would now be visible instead of silently counted.
- Same document everywhere: the advisor print, the bookkeeping RO-detail pane and the bookkeeping
  print all get this from the one builder (§4).

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

## 4. The three consumers
- **Advisor board — `printRo(receipt)`** (`advisor-board.html`): a **thin wrapper** — gathers
  `currentRo` / `currentLines` / `shop_settings` / `currentPayments` (+ `receipt` for diag mode)
  → `window.RoInvoice.buildPrintDoc(...)` → `window.open` + `document.write`. No visual change to
  the estimate/RO/unpaid printout; paid ROs now print the PAID document.
- **Bookkeeping board — the per-RO detail LEFT pane** (`bookkeeping-board.html`, gated by
  `feature_bk_ro_detail`; see [[financial-pulse]] §9): injects `INVOICE_CSS` once, then embeds
  `<div class="roinv roinv-embed">${buildInvoiceHtml(...)}</div>` — the **full real invoice**
  instead of the old brief summary. It fetches the full RO fields + `ro_payments` for this (so a
  closed/paid RO shows PAID inside the panel too). The RIGHT pane keeps receipts + profit-over-parts.
- **Bookkeeping board — `printRoDetail()`, the "🖨 Print / Save PDF" button** in the RO-detail
  header (`#finRoPrint`, hidden until an RO actually loads): Daiana attaches the customer invoice
  to the job in QuickBooks, and used to screenshot the LEFT pane in pieces. It calls
  `buildPrintDoc` with **the same opts the LEFT pane already embeds** (`ro`, `ro.ro_line_items`,
  `shop_settings`, `ro_payments`, `receipt: null`), so print and embed cannot diverge: the two
  differ only by `buildPrintDoc`'s `@page` + `INVOICE_CSS` wrapper. Renders from **RO data, not
  from the screen**, so scroll position and the split layout are irrelevant.
  - **LEFT SIDE ONLY.** The parts receipts and the cost/profit column are this board's own
    analysis, not the customer document, and never appear in what the button produces.
  - **Never receipt mode** — the quick diag-fee receipt stays an advisor-only entry point.
  - The button is **hidden for an ALLDATA-only job** (no `repair_orders` row → nothing to print)
    and is cleared while a new RO loads, so the previous RO can't be printed mid-fetch.

## 5. "Warranty given" — the warranty the shop GIVES (Kevin, Sep 11)
**Why.** The team typed warranties into Advisory notes — 32 of 114 prod ROs by 2026-09-19, the same
1 yr / 12,000 mi term spelled 13 different ways — while `shop_settings.legal_terms` (the small print)
already tells the customer the only warranties are "the ones explicitly stated in this document".
There was no field that stated one. This is that field.

**Data.** `repair_orders.warranty_terms` (text, nullable; CHECK `char_length <= 2000`;
`migrations/20260919_ro_warranty_terms_{SANDBOX,PROD}.sql`, hand-run, no backfill). It holds the
**full text** that prints — never a preset name — so rewording a preset later never changes a
document a customer already has. NULL = none stated.

**Presets** — `shared/warranty-presets.js` (`WARRANTY_PRESETS`), the one list, wording approved
word-for-word by Cris 2026-09-19, in picker order:
1. Transmission Rebuild — 1 year or 12,000 miles parts & labor warranty, whichever comes first.
2. Remanufactured Transmission — 3 years or 100,000 miles … provided by the unit's manufacturer. *(vendor)*
3. Remanufactured Transmission — 3 years / unlimited miles … provided by the unit's manufacturer. *(vendor)*
4. Customer-provided parts — no warranty can be given on this repair.
5. Customer declined the recommended repair — no warranty can be given on the work performed.
6. Comeback — the original warranty still stands.

(Kevin's "1 Year parts & labor" is deliberately not a preset — custom text covers it.) Each preset
has a short `label` for the picker (UI only) and the approved `text`. `vendor: true` on 2 and 3 marks
a manufacturer's (third-party) warranty — **data, not hard-coded**. `advisor-board.html` carries no
copy of the wording (test-locked).

**The box** (advisor board only) — RO detail, **Complaint & Notes card, directly under Advisory
Notes**: label *"Warranty given — prints on the estimate & invoice"* (NEW badge until `2026-09-28`,
[[new-badge]]), an **"Insert preset…"** picker, a textarea, a save-status line, and the vendor warning.
- **Insert preset** (`onWarrantyPresetPick` → `insertPreset`): an **empty** box gets the preset; a box
  with text **keeps it and gets the preset on a new line** (trailing blank lines dropped first). The
  picker resets to "Insert preset…" — it's an action, not a state. The box is always editable.
- **Save** (`queueWarrantySave`, on the textarea's `change` and right after a pick): `warrantyForSave`
  trims the outer whitespace, keeps line breaks, normalises `\r\n`, blank → NULL, over 2000 →
  refused with a red status. Written with `.select('id, warranty_terms')` so a 0-row (RLS) write is a
  failure; a failure shows red status + an alert and **reverts** the in-memory value so a print right
  after can't show unsaved text. Saves are **chained** (land in the order made) and each targets the
  RO that was open when the edit happened. Not the generic `updateRoField`, which only logs errors.
- **Vendor warning** (`paintWarrantyVendor`, never printed): while the box contains preset 2's or 3's
  text, a yellow note shows under it — *"⚠ Vendor warranty — confirm this supplier's exact terms
  before putting it on the invoice."* Content-based, so it appears on the pick, again when the RO is
  reopened, and goes away if that text is deleted.
- **Pre-migration / module failure:** the box and picker are disabled with *"Warranty needs the
  database update"* / *"presets couldn't load"*. `renderWarrantyTerms` waits for the module
  (`wpReady`, the `?ro=` deep-link race).
- **Not auto-filled** from the job category or a package (by decision).

**Not the Warranty / Comeback switch.** That right-column switch marks a visit as comeback work, lives
on the floor row (`shopboard_*.warranty`) and never prints ([[comeback-warranty]]). The two are kept
apart on screen: different cards, different wording ("Warranty given" vs "Warranty / Comeback").

**Print** (`buildInvoiceHtml`): when `warranty_terms` is non-blank, a **"Warranty"** section
(`<div class="warranty"><h2>Warranty</h2><div class="wtext">…`) prints **after the totals** and
**just above** the authorization + signature (estimate / RO / unpaid invoice) or the **PAID** block
(paid) — so the customer signs under it. **Never in receipt mode.** Blank → nothing (old ROs print as
before). Text is escaped; **line breaks print** (`.wtext { white-space: pre-line }`). Adding the
block changes no other byte of the document (test-locked). All three consumers (§4) get it.

**Line breaks in Advisory notes** (same change): the value is wrapped in `<span class="ml">`
(`white-space: pre-line`, inline-block beside its label), so multi-line advisories print on separate
lines instead of one run-on line. This changes reprints of old multi-line ROs (approved). **Symptoms
/ DTC** (`complaint`) still collapses its line breaks — not in this slice.

**Bookkeeping** names its RO columns (`RO_COLS` in `openRoDetail`): `warranty_terms` is included,
and if the database doesn't have it yet the query retries without it (then without `card_fee_on`,
as before) — newest optional column first.

## Known gaps & open questions (as of 2026-09-18; §5 items as of 2026-09-19)
- **§5: Symptoms / DTC line breaks still collapse** on the print (the complaint box says "one per
  line"). Same one-line fix as Advisory notes; not approved in this slice.
- **§5: the warranty prints as of the moment of printing.** An estimate printed with one warranty and
  an invoice printed after an edit can differ; there is no lock after close.
- **§5: old ROs keep their warranty inside Advisory notes** (no backfill), so on their reprints it
  appears under Advisory notes, not in a Warranty block.
- **5 of the sandbox's 10 fee lines are marked `taxable`** (the 4 old `CARD PROCESSING FEE` lines
  and RO #6011), so sales tax is charged on those fees. The old `addCardFee` always inserted
  `taxable:false` (and the live switch that replaced it is never taxed — [[card-fee]]). Left as-is by decision (display-only change); flagged for a data decision.
- The fee row shows only the amount, not qty × price. Every fee line today is qty 1.
- **Embed width** — the invoice is designed for a 7.5in page; in the bookkeeping split it renders
  in a ~1.5fr column (modal widened to 1140px) with `overflow-x:auto`. Fine on desktop; tight on
  a phone (the modal isn't a mobile target for the bookkeeper).
- **`printRo` still reads `currentPayments`** (module global) for the paid state — correct while
  the RO detail is open (payments are loaded there). Printing a paid RO whose payments haven't
  loaded would fall back to the unpaid layout (fails safe).
- **A second `DOC_LABEL` map sat unread in `advisor-board.html`** until 2026-09-11, when it was
  deleted (it was declared and never referenced — the live map is `shared/ro-invoice.js:50`).
  `shared/ro-invoice.js` is now the ONLY copy; don't re-add one.
- **The bookkeeping print button shares `printRo`'s pop-up dependency** — a blocked pop-up shows
  the same "please allow pop-ups" alert. There is no in-page fallback on either board.
- **`esc` now also escapes `&`/`"`/`'`** (the old inline board `esc` did only `<`/`>`); output
  renders identically in HTML text — no visual change, slightly more correct.

## Where it lives in the code
- **Builder:** `shared/ro-invoice.js` (`buildInvoiceHtml` — totals box incl. `feeRows`, the
  `warrantyBlock`, the `.ml` advisory span; `buildPrintDoc`, `INVOICE_CSS`) + `shared/ro-invoice.test.js`.
- **Warranty given (§5):** `shared/warranty-presets.js` (`WARRANTY_PRESETS`, `VENDOR_WARNING`,
  `MAX_WARRANTY_LEN`, `presetById`, `insertPreset`, `hasVendorWarranty`, `warrantyForSave`) +
  `shared/warranty-presets.test.js`; `advisor-board.html` — the ESM loader (~1285),
  `#cdRoWarrantyTermsField` (~2239), `.cd-wt-*` CSS (~436), `renderWarrantyTerms` (~6745) /
  `queueWarrantySave` (~6770) / `onWarrantyPresetPick` (~6798), the call in `populateRoEditFields` (~5953),
  the listeners; `bookkeeping-board.html` `RO_COLS` + the optional-column fallback loop. Schema:
  `migrations/20260919_ro_warranty_terms_{SANDBOX,PROD}.sql`.
- **Advisor wrapper:** `advisor-board.html` `printRo` + the `import * as RoInvoice` module tag.
- **Bookkeeping embed + print:** `bookkeeping-board.html` `openRoDetail` (full RO + payments
  fetch) / `renderRoDetail` (LEFT pane embed + pre-tax profit; arms the print button) /
  `printRoDetail` + `#finRoPrint` + `.fin-drill-print` + the `import * as RoInvoice` module tag.
- **Related docs:** [[payments]] (the `ro_payments` the PAID state reads), [[financial-pulse]]
  (§9 the bookkeeping consumer), [[ro-line-items]] (the lines the totals sum; package fold-in),
  [[packages]] (package lines print under Parts), [[settings]] (shop profile + `payment_methods`).

## Session change log
- 2026-09-19 — **§5 "Warranty given"**: `repair_orders.warranty_terms` (full text, ≤2000), the box +
  "Insert preset…" (insert when empty, else append on a new line) + vendor warning on the advisor RO
  detail, `shared/warranty-presets.js` (Cris-approved wording), the print block above the signature /
  PAID, line breaks kept in it and in Advisory notes, Bookkeeping `RO_COLS` fallback. Branch
  `feat/ro-warranty-terms`, unmerged.
- 2026-09-18 — Card fee became a live per-RO switch; RO totals here now come from `shared/ro-totals.js` (see [[card-fee]]). Branch `feat/card-fee-live`, unmerged.
- 2026-09-18 — **Fee lines print by name** (§2a): the single "Fees" totals row became one row per
  fee line labelled with its stored description (blank → "Fee"). Display only — totals, tax and
  PAID state proven identical to the cent on 10 real fee ROs (incl. #6011 and the old
  `CARD PROCESSING FEE` ones) + 1 no-fee RO. `ro-invoice.test.js` +6 tests (17 total).
  **Staging, signed in as ZZ Test Advisor (`223b82c`):** the advisor Print button on RO #6011
  printed `Card processing fee (4.00%) $6.66`, total $189.20, PAID; on RO #5227
  `CARD PROCESSING FEE $150.97`, total $4283.39 — both unchanged totals, no "Fees" row.
  **Bookkeeping verified signed in as ZZ Test Bookkeeping on `223b82c`:** RO-detail left pane AND
  the real Print button on #6011 (`Card processing fee (4.00%) $6.66`, $189.20, PAID) and #5227
  (`CARD PROCESSING FEE $150.97`, $4283.39) — same totals as the old-vs-new table, no "Fees" row.
- 2026-09-11 — Added the bookkeeping **"🖨 Print / Save PDF"** button (`printRoDetail`) so Daiana
  can save the customer invoice as a PDF for QuickBooks instead of screenshotting the panel. No
  new document code: it reuses `buildPrintDoc` with the LEFT pane's own opts. Deleted the unread
  duplicate `DOC_LABEL` in `advisor-board.html`. Verified the customer document is byte-identical
  before/after (all four stages + receipt mode) and identical across both boards, incl. the PAID
  document; confirmed the printed doc carries no receipts/cost/profit content.
- 2026-08-09 — Created. Extracted `advisor-board.html` `printRo` into the shared PURE builder
  `shared/ro-invoice.js` (`buildInvoiceHtml` / `buildPrintDoc` / scoped `INVOICE_CSS`; 11 tests).
  Refactored `printRo` to a thin wrapper (no visual change to the estimate/unpaid printout).
  Added the **PAID** body (stamp, per-payment lines, $0 balance, combined method, date paid)
  replacing the auth/signature when `status∈{invoice,closed}` and paid in full. Embedded the same
  builder in the bookkeeping RO-detail LEFT pane (full invoice, incl. PAID). Verified live: 6022
  paid → PAID doc; 6025 estimate → unchanged auth/signature.
