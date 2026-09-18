# How the card processing fee is wired (live switch + the one RO total)

> Doc: `/docs/wiring/card-fee.md`
> Last updated: 2026-09-18 — written from the code on branch `feat/card-fee-live` (base
> `ed4d424`, UNMERGED). Every claim checked against `shared/ro-totals.js` (+ test), the 9 call
> sites listed in §3, and `migrations/20260918_ro_card_fee_on_{SANDBOX,PROD}.sql`.
> Status: ✅ sandbox STEP 1 + STEP 2 applied (2026-09-18) and verified in a real browser on
> `test.*` signed in as ZZ Test Advisor against `68ae803` — see the change log. Bookkeeping board
> not yet driven (needs a bookkeeping/owner login). Prod: migration NOT run, code NOT on main.

## 0. In one line
The card fee is an **ON/OFF switch per RO** (`repair_orders.card_fee_on`, default OFF). When
ON, every RO total adds **`card_fee_pct × (all lines + sales tax)`**, recalculated live like
Tax — computed by **one shared calculator** (`shared/ro-totals.js`) that every screen, the
printed invoice and bookkeeping use, so the number is the same everywhere.

## 1. The rule — `computeRoTotals(lines, { taxRate, exempt, cardFeeOn, cardFeePct })`
- `subtotal` = Σ qty × unit_price over **all** lines (a stored legacy fee line included);
  `tax` = taxable lines × tax rate (0 when the customer is tax-exempt);
  `preFeeTotal` = subtotal + tax — **the fee's base, the same base the old "+ Card fee" button
  used**.
- `cardFee` = `round2(card_fee_pct × preFeeTotal)` when the switch is ON; not taxable.
- `total` = preFeeTotal + cardFee. `preTaxRevenue` = subtotal + cardFee (for profit figures).
- **It follows the lines.** Nothing is stored: add / edit / delete a line and the fee moves with
  it, exactly like Tax (the advisor board's `renderLines` → `recalcTotals` path).
- **It can't be applied twice** — it's a boolean, not a line.
- **Payments never feed it.** `computeRoTotals` has no payments input; balance is
  `roBalance(totals, payments)` = total − Σ payments. A deposit only lowers the balance.

## 2. The rate — `shop_settings.card_fee_pct`, and nowhere else
- One edit in Settings (Owner/GM → RO & Pricing → Card fee %) changes it everywhere; the row
  label follows it (`cardFeeLabel` → `Card processing fee (4.00%)`).
- **No code fallback.** `shared/board-settings.js` used to fall back to **0.03** when the settings
  row couldn't load, while the shop charges 4%. That default is now `null`. An unreadable rate
  gives `cardFeeUnavailable=true`, fee 0, and every surface says **"Card processing fee — rate
  unavailable"** instead of guessing. Both Print buttons **refuse to print** in that state (a
  printed total missing the fee would be wrong on paper).
- Settings load asynchronously; the advisor board re-totals the RO detail, the board cards and an
  open customer record on `onShopSettingsChanged`, and bookkeeping re-totals Financial Pulse
  (`FinancialPulse.refreshRates()`), so an early render never sticks at "unavailable".

## 3. Where RO totals are computed — all through the calculator
| # | Surface | Code | Uses |
|---|---|---|---|
| 1 | RO-board cards + card balance | `advisor-board.html` `roTotal(ro)` / `roBalance` | `.total` |
| 2 | Payments box (Total / Paid / Balance / Paid-in-full) | `roTotalNum()` | `.total` |
| 3 | RO detail totals box (Subtotal / Tax / **Card fee** / Total) | `recalcTotals()` | all fields |
| 4 | Close archive → `completed_jobs` (labor / parts / tax / total / balance_due) | `archiveToCompletedJobs` | `.tax`, `.total`; the fee rides in the non-labor bucket, where a stored fee line always landed |
| 5 | Printed invoice, bookkeeping RO-detail pane + print | `shared/ro-invoice.js` | `.tax`, `.total`, fee row after Taxes |
| 6 | Financial Pulse: paid-in-full test, income amount, pipeline, follow-up list | `bookkeeping-board.html` `roTotal(ro)` | `.total` |
| 7 | Bookkeeping RO-detail pre-tax profit | `renderRoDetail` | `.preTaxRevenue` |
| 8 | Customer record per-RO totals + lifetime $ | `shared/customer-record.js` `roInvoiceTotal` / `totalsByRo` (`cardFeeOnByRo`) | `.total` |
| 9 | Profit by RO sale (owner + bookkeeping) | `shared/profit-by-ro.js` `roSale` | `.preTaxRevenue` |

The advisor board's helper is **`roTotalsOf(lines, ro)`** (tax rate + card-fee rate from
`shopCfg()`); bookkeeping and Profit by RO call **`RoTotals.totalsForRo(ro, settings,
taxFallback)`**. Each keeps its **existing tax fallback** (advisor/invoice 0.07, bookkeeping
0.065) — unchanged by this slice. **Commission** is untouched: fees carry 0 gross profit
(`lineGrossProfit`), and the live fee isn't a line at all.

Every read feeding these carries `card_fee_on` and the lines' `line_type` + `description` (for
the legacy check, §4). Each read drops `card_fee_on` and retries if the column doesn't exist yet
(STEP 1 not run), so no board breaks between deploy and migration: kanban `EXTRAS` tier,
customer record peel-off loop, bookkeeping `bkCardFeeCol`, RO-detail retry, commission
`_colAvail.card_fee_on`.

`shared/ro-totals.test.js` locks the rule **and** asserts the 9 sites route through the
calculator (static guard), that the "+ Card fee" button is gone, and that the 3% fallback is gone.

## 4. The switch UI, and old stored fee lines
- Line Items header: **`☐ Card fee (4.00%)`** (`#cdCardFeeOn`), replacing "+ Card fee". Toggling
  writes `card_fee_on` with `.select()` (a 0-row write is an error, not a silent no-op), reverts
  the box and alerts on failure, then re-totals and refreshes the board-card cache.
- Totals box: a **`Card processing fee (4.00%) $X`** row between Tax and Total (`#cdCardFeeRow`),
  shown only when the fee applies (or "rate unavailable").
- **Legacy lines.** ROs from before the switch may carry a stored card-fee LINE (`line_type
  'fee'`, description starting "Card processing fee" — the button's wording — or the old
  uppercase "CARD PROCESSING FEE"). `isLegacyCardFeeLine` detects them. On such an RO the switch
  is **hidden** with the note *"Card fee is a stored line on this RO"*, and even if
  `card_fee_on` were true the calculator forces the live fee to 0 (`cardFeeBlocked`) — **the two
  never stack**. A different fee line (towing, etc.) doesn't block the switch.
- Before STEP 1 has run on a database the switch is hidden with *"Card fee switch needs the
  database update"* (`'card_fee_on' in currentRo` is false).

## 5. The migration — two files, two steps, run by hand
`migrations/20260918_ro_card_fee_on_SANDBOX.sql` and `…_PROD.sql` — identical shape, opposite
`app_env` guards (staging-db.md §8.2/§8.3: a NULL stamp raises; the wrong project raises / matches
0 rows).
- **STEP 1 (schema):** `alter table public.repair_orders add column if not exists card_fee_on
  boolean not null default false` + comment + `notify pgrst`. Existing table RLS covers it.
- **Deploy the app** that reads `card_fee_on` to that database's site.
- **STEP 2 (data), only after that deploy:** one atomic statement over an **explicit RO list**
  that re-checks `status in ('estimate','ro')` at run time — backs each stored card-fee line up
  (whole row as jsonb) into `ro_card_fee_line_backup_20260918` (RLS on, no policies → SQL-editor
  only), sets `card_fee_on = true`, deletes the line, and returns the counts. An UNDO block
  (commented) re-inserts the exact rows and switches off.
- **What it does NOT touch:** closed ROs (they keep their stored line forever — history as
  charged), `invoice`-status ROs (#6074 on prod, by decision), and any RO not listed.
- **Prod list (Cris-approved 2026-09-18):** 5501, 6023, 6025, 6054, 6072, 6073, 6077, 6079, 6080,
  6083, 6084, 6086, 6087, 6093 — incl. the 5 declined estimates. Totals move on two: **5501
  +$2.94** (its old line was taxable and lower than 4% of today's lines) and **6054 +$0.68**
  (lines changed after the fee was added). #6084 has a $150 cash deposit — the fee is unchanged by
  it. **Sandbox list:** 5227, 5501, 6023, 6025, 6026 (the sandbox is an older copy).

## Known gaps & open questions (as of 2026-09-18)
- **Pre-existing, surfaced by this slice's browser pass — not caused by it:**
  - **Tax isn't rounded to cents before it's added up.** The totals box shows tax rounded
    ($699.21) but the total adds the unrounded $699.205, so the visible rows can sum 1¢ away from
    the Total (sandbox #6026: rows $11914.46, Total $11914.45; before the switch it was $11917.44
    vs $11917.43), and a paid-in-full RO can show Balance "$-0.00". Needs a rounding decision.
  - **A board card's "Bal" goes stale after a payment is recorded** until the list reloads:
    `recordPayment` / `deletePayment` never update `allRos[].ro_payments`, and nothing listens on
    `ro_payments`. The total half of the card is live (it includes the fee).
  - **Opening an RO can WRITE.** `updateBookHoursAuto` (Book Hours feature) saves
    `repair_orders.book_hours` (+ mirrors `flag_hours` to a floor row) whenever the stored value
    differs from the lines' auto-total. So "just looking" at an RO is not read-only.
- **Payment method isn't linked to the switch.** Recording a card payment does not turn the fee
  on (and a cash payment doesn't turn it off) — the advisor flips it. By design for this slice.
- **A closed RO can still be toggled** (like its lines can still be edited). Its
  `completed_jobs` archive row is only rewritten on the next close.
- **Stored legacy lines stay on closed ROs**; some no longer equal 4% of their lines (e.g. prod
  #6045 $238.40 vs $210.46) — they're history as charged and are not recomputed.
- Tax fallbacks still differ by board (0.07 vs 0.065) when settings fail to load — pre-existing,
  out of scope here.

## Where it lives in the code
- `shared/ro-totals.js` (+ `shared/ro-totals.test.js`, 19 tests): `computeRoTotals`,
  `totalsForRo`, `roBalance`, `normalizeRate`, `cardFeeLabel`, `isLegacyCardFeeLine`,
  `hasLegacyCardFee`. Loaded as `window.RoTotals` on the advisor, bookkeeping and owner boards;
  imported by `shared/ro-invoice.js` and `shared/customer-record.js`.
- `advisor-board.html`: `roTotalsOf`, `roTotal`, `roTotalNum`, `recalcTotals`,
  `renderCardFeeControl`, `setCardFeeOn`, `#cdCardFeeOn` / `#cdCardFeeNote` / `#cdCardFeeRow`,
  `.cd-cardfee-*` CSS, `cardFeeColAvailable`, `archiveToCompletedJobs`, `printRo` guard,
  customer-record read + `cdRefreshShopSettings`.
- `bookkeeping-board.html`: `roTotal`, `openRoQuery` / `payRoQuery` / `bkCardFeeCol`, RO-detail
  `RO_COLS` + retry + `preTaxRevenue`, `printRoDetail` guard, `FinancialPulse.refreshRates`.
- `shared/profit-by-ro.js` `roSale`; `shared/commission-engine.js` `fetchInputs` (reads
  `card_fee_on`, `customers(tax_exempt)`, line `taxable`/`description`).
- `shared/board-settings.js` `SHOP_DEFAULTS.card_fee_pct = null`.
- `migrations/20260918_ro_card_fee_on_SANDBOX.sql`, `migrations/20260918_ro_card_fee_on_PROD.sql`.

## Session change log
- 2026-09-18 (later) — **Sandbox migrated + browser-verified as ZZ Test Advisor (`authenticated`,
  `68ae803`).** STEP 1 then STEP 2 run by Cris on the sandbox (5 ROs converted, 5 lines backed up).
  Converted ROs show the live fee row: #5227 $4287.50, #5501 $3069.14, #6023 $8018.93, #6025
  $8251.48 (last two unchanged), #6026 $11914.45 (1¢ under the $11914.46 predicted — the
  pre-existing unrounded-tax effect above). On #5413: switch ON → fee $0.89; add a $140 labor line →
  $6.86; edit it to $200 → $9.41; $50 cash deposit → fee unchanged, balance $194.76; delete
  deposit, delete line → $0.89; switch OFF → row gone. Same total ($244.76) on RO detail, payments
  box, board card (after reload — stale-balance gap above), print (fee row after Taxes) and customer
  record. #6011 (stored line): switch hidden with the note, $189.20, and still $189.20 with
  `card_fee_on` forced true (then restored). 0 × 401/403/42501. Test data restored.
- 2026-09-18 — **Created.** Card fee moved from a one-time stored line ("+ Card fee" /
  `addCardFee`) to a live per-RO switch; all 9 RO-total sites routed through the new
  `shared/ro-totals.js`; 3% code fallback removed. With every switch off, the new invoice builder
  renders **byte-identical** documents to `ed4d424` on 54 real sandbox ROs (incl. the 10 with a
  stored fee line). Branch `feat/card-fee-live`, unmerged.
