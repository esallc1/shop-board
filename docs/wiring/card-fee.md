# How the card processing fee is wired (live switch + the one RO total)

> Doc: `/docs/wiring/card-fee.md`
> Last updated: 2026-09-18 (evening) — **§3a added: no total may render before the calculator has
> loaded** (fixes the RO Board's "Something failed in the background: … 'computeRoTotals'" on
> page load). Branch `fix/ro-totals-load-order` off `main` `b7ba7dd`, **unmerged**; §3a, Known
> gaps and Where-it-lives re-checked against the code this session; staging pass in the change log.
> Previously: 2026-09-18 — verified vs commit `41e1883` (LIVE on prod — www/board/apex). Every
> claim checked against `shared/ro-totals.js` (+ test), the 9 call sites listed in §3, and
> `migrations/20260918_ro_card_fee_on_{SANDBOX,PROD}.sql`.
> Status: ✅ sandbox STEP 1 + STEP 2 applied (2026-09-18) and verified in a real browser on
> `test.*` against `68ae803` — advisor board as ZZ Test Advisor AND bookkeeping board as ZZ Test
> Bookkeeping (see the change log). **Prod: code live (`41e1883`, 2026-09-18) and STEP 1 + STEP 2
> run by Cris on 2026-09-18** — exactly the 14 approved ROs switched on, results in the change log.

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

### 3a. Load order — no total renders before the calculator has loaded
**The race (regression from `68ae803`, fixed 2026-09-18).** `shared/ro-totals.js` is an ES
module, loaded by an inline `<script type="module">` that sets `window.RoTotals`. Module scripts
are **deferred** — they run only after the whole page is parsed. Each board's main `<script>` is
**classic** and runs **during** parsing, starting its data loads immediately. When a read came
back before the module had run, the render touched `window.RoTotals` while it was still
`undefined`. On the advisor board that was `loadRecentList → renderKanban → roTotal →
roTotalsOf` at start-up: the red **"Something failed in the background: Cannot read properties
of undefined (reading 'computeRoTotals')"** banner and a partly-rendered RO list (measured on
staging at `b7ba7dd`: banner on 4 of 8 reloads, 17 cards instead of 18 when it hit).

**Paths that could run before the module (all now gated):**
| Board | Entry point | Reaches |
|---|---|---|
| advisor | `loadRecentList` at start-up (and realtime/focus re-runs) | board cards: `roTotal` / `roBalance` (#1) |
| advisor | `openRo` — the `?ro=` deep link fires it during parsing | detail totals `recalcTotals` (#3), payments `roTotalNum` (#2) |
| bookkeeping | `FinancialPulse.update` from the Overview load; `refreshRates` on settings load | `roTotal` (#6) |
| bookkeeping | `openRoDetail` (click) | `renderRoDetail` `preTaxRevenue` (#7) |
| owner + bookkeeping | `ProfitByRO` `loadData` | `roSale` (#9) |
Not affected: `shared/ro-invoice.js` (#5) and `shared/customer-record.js` (#8) **import** the
calculator, so whenever they exist it does; the close archive (#4), card-fee toggle and quick
receipt only run inside an already-open RO.

**The fix — `shared/ro-totals-ready.js`** (CLASSIC, 7 tests in `shared/ro-totals-ready.test.js`),
loaded on all three boards **before** the main script (and before `profit-by-ro.js`):
`cdRoTotalsReady()` resolves with `window.RoTotals` as soon as it exists, or with **null** if it
never will — knowable because `DOMContentLoaded` fires only after every deferred/module script has
run or failed. Each entry point above **awaits it before rendering**:
- `loadRecentList` → no cards until ready; failed → the message in the Estimate column.
- `openRo` → failed → an alert; the RO isn't opened.
- `FinancialPulse.update` (now `async`) → failed → the Pulse card shows only the message;
  `refreshRates` is a no-op until ready (`update` paints once it is).
- `openRoDetail` → failed → the message in the pane.
- `ProfitByRO.loadData` → failed → the message instead of the list.
**Never a total computed another way:** `roTotalsOf`, bookkeeping `roTotal` and `roSale` now
**throw** a plain message if reached without the calculator, and `roSale`'s old silent fallback
(a hand sum that dropped the card fee) is **deleted**. The one message is
`window.cdRoTotalsMissingText`: *"RO totals couldn't load, so no totals are shown (they'd be
missing the card fee). Reload the page."* `shared/ro-totals.test.js` statically guards the
include order, every await, the throws and the missing fallback.

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
- **Prod list (Cris-approved and RUN 2026-09-18):** 5501, 6023, 6025, 6054, 6072, 6073, 6077, 6079, 6080,
  6083, 6084, 6086, 6087, 6093 — incl. the 5 declined estimates. Totals move on two: **5501
  +$2.94** (its old line was taxable and lower than 4% of today's lines) and **6054 +$0.68**
  (lines changed after the fee was added). #6084 has a $150 cash deposit — the fee is unchanged by
  it. **Sandbox list:** 5227, 5501, 6023, 6025, 6026 (the sandbox is an older copy).

## Known gaps & open questions (as of 2026-09-18)
- ~~Page-load race: a render could reach `window.RoTotals` before its module ran~~ — fixed, §3a.
  **Not audited:** the boards' other `window.X` module globals (e.g. `window.CustomerRecord`,
  `window.WarrantyMirror`) are set by the same kind of deferred module script, so any of them read
  during start-up could race the same way. Only the RO-total paths were checked in this slice.
- **Pre-existing, surfaced by this slice's browser pass — not caused by it:**
  - **Tax isn't rounded to cents before it's added up.** The totals box shows tax rounded
    ($699.21) but the total adds the unrounded $699.205, so the visible rows can sum 1¢ away from
    the Total (sandbox #6026: rows $11914.46, Total $11914.45; before the switch it was $11917.44
    vs $11917.43), and a paid-in-full RO can show Balance "$-0.00". Needs a rounding decision.
    Because the boards also FORMAT differently (advisor/invoice `toFixed(2)`, bookkeeping lists
    `toLocaleString`), the same unrounded total (11914.455) shows **$11914.45** on the advisor
    board, the printed invoice and the bookkeeping RO-detail pane but **$11,914.46** in
    bookkeeping's Financial Pulse lists — and Financial Pulse books income at the RO total, so a
    customer who pays the printed $11,914.45 is counted as $11,914.46 of income.
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
- **Load order (§3a):** `shared/ro-totals-ready.js` (+ `.test.js`, 7 tests) — `cdRoTotalsReady`,
  `cdRoTotalsMissingText`; awaited in advisor `loadRecentList` / `openRo` (helpers `rtReady`,
  `RT_MISSING`), bookkeeping `FinancialPulse.update` / `openRoDetail` (same helpers),
  `shared/profit-by-ro.js` `loadData`.
- `shared/ro-totals.js` (+ `shared/ro-totals.test.js`, 20 tests): `computeRoTotals`,
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
- 2026-09-18 (evening) — **§3a: page-load race fixed.** New classic `shared/ro-totals-ready.js`
  (`cdRoTotalsReady`), included before the main script on advisor / bookkeeping / owner; every
  start-up path awaits it; `roTotalsOf` / bookkeeping `roTotal` / `roSale` throw instead of
  guessing; `roSale`'s no-fee fallback deleted; failed load → one clear message. +7 ready tests,
  +1 static guard. Branch `fix/ro-totals-load-order`.
- 2026-09-18 (prod) — **Shipped.** Order: PROD STEP 1 (Cris; verify: boolean / NO / false,
  switched_on 0, 112 ROs) → `main` fast-forwarded `ed4d424..41e1883` (www/board/apex on `41e1883`;
  `shared/ro-totals.js`, `advisor-board.html`, `shared/ro-invoice.js`, `bookkeeping-board.html`,
  `shared/board-settings.js` byte-identical) → PROD STEP 2 (Cris; all 14: card_fee_on true, stored
  0, backed_up 1, switched_on_total 14; backup table RLS on, 0 policies). Read-only post-check via
  the API + `shared/ro-totals.js` (no RO opened in a browser, so no book_hours re-saves): 20/20
  totals as expected — 5501 $3069.14 (+$2.94), 6054 $3340.50 (+$0.68), the other 12 unchanged,
  #6084 fee unchanged by its $150 deposit; #6074 and closed ROs 5227/6011/6045/6050/6069 keep their
  stored lines, totals unchanged; `card_fee_on = true` on exactly the 14.
- 2026-09-18 (later still) — **Bookkeeping board verified as ZZ Test Bookkeeping (`authenticated`,
  `68ae803` code).** Financial Pulse Follow-up list AND open-RO list show the converted ROs at the
  live-fee totals (#5227 $4,287.50, #5501 $3,069.14, #6023 $8,018.93, #6025 $8,251.48, #6026
  $11,914.46 — the 1¢ formatter gap above); the $71,889.93 pipeline equals an independent
  RoTotals recompute of a fresh read. RO detail #5227 / #6026: fee row by name ($164.90 / $458.25),
  totals $4287.50 / $11914.45 (= advisor), pre-tax subtotal $4,035.89 / $11,215.25 = lines + fee
  (revenue, as the stored line was). Real Print on #5227: fee row + $4287.50. Paid-in-full: no
  switched-on RO had payments, so a TEMPORARY $11,914.45 card payment on #6026 → Income (this week)
  "$11,914.46 · 1 paid RO · ✓ matches card"; payment deleted (0 left, income back to $0.00).
  0 × 401/403/42501.
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
