# How RO line items (the Add/Edit-Line pop-up) are wired

> Doc: `/docs/wiring/ro-line-items.md`
> Last updated: 2026-08-07 — verified vs commit `ba3fcf0`
> Status: ✅ BUILT + verified live this session. The line editor is a pop-up
> window (no inline row editing). Verified end-to-end on real ROs: read-only rows,
> add/edit/delete round-trip, labor auto-Sell, parts margin, package resolve,
> totals unchanged. New column `ro_line_items.unit_cost` migration
> (`20260807_ro_line_unit_cost.sql`) is written but **NOT yet applied** — parts
> cost degrades quietly until it is (the line still saves).

## 0. In one line
Each RO line is a **clean read-only row** (type · description · qty/hrs · unit $ ·
tax · line total) with a **pencil** (edit) and **×** (delete); "+ Add line" and the
pencil both open one **Add/Edit-Line pop-up** where you pick a type and the fields
adapt. Totals/tax math and the printed invoice are unchanged — only the *entry UI*
changed.

## 1. The line table — read-only rows
- Markup: the `Line Items` card, table `.cd-lines-table`, body `#cdLinesTbody`
  (`advisor-board.html`). Columns: Type · Description · Qty/Hrs · Unit $ · Tax ·
  Line · (actions).
- `renderLines()` (`advisor-board.html:4929`) renders each `currentLines` row as
  **static cells** — no inputs. Type shows as a chip (`LINE_TYPE_LABEL`); the
  description cell appends only `#part_number` for parts. **No tech-pay / R&R
  annotations on the advisor's rows** — hours already show in the Qty/Hrs column,
  and R&R is the manager's (see §2). Each row wires a **pencil** →
  `openLineModal(line)` and a **×** → `deleteLine(id)` (now with a confirm).
- Everything downstream still reads the **data model** (`currentLines`), not the
  DOM, so `recalcTotals()` / `roTotalNum()` / the print fold-in are untouched.

## 2. The Add/Edit-Line pop-up
A single `.modal-overlay` `#cdLineModal` (`advisor-board.html:1655`), reusing the
shared modal + `.intake-field` styles. `openLineModal(line)`
(`advisor-board.html:5168`) sets `lineModalEditId` (null = add), fills the **Type**
`<select>` from `lineTypeOptions()`, and calls `renderLineFields()`
(`advisor-board.html:5197`) which paints the fields for the current type. Changing
the Type re-renders the fields; **Description + Taxable carry over** across type
switches (`captureLineCommon` → `lineModalDraft`). `saveLineModal()`
(`advisor-board.html:5301`) builds the payload and writes it; Cancel / × / backdrop
close without saving.

### Fields per type (and how each maps to storage — math unchanged)
The customer total is always `Σ(quantity × unit_price) + tax`, so every type stores
into `quantity` / `unit_price`; type-specific extras use their own columns.

| Type | Fields shown | → `quantity` | → `unit_price` | Other columns |
|---|---|---|---|---|
| **Labor** | Description, **Hours** (labelled "Qty" when Book Hours OFF), Rate ($/hr, default = RO&Pricing labor rate), **Sell (auto = Hours×Rate, read-only)**, Taxable | hours | rate | — |
| **Parts** | Part #, Description, **Cost** (internal), **Sell**, Qty, Taxable | qty | sell | **`unit_cost` = cost** |
| **Package** | Unit (grouped `<optgroup>` dropdown), Price (editable), Taxable — **no R&R field** | 1 | price | `package_unit_id`, `description`=unit_code, `rr_hours` (silent) |
| **Fee / Shop Supply / Hazmat** | Description, Amount (Shop Supply/Hazmat prefill their RO&Pricing default), Taxable | 1 | amount | — |

- **Labor** field is labelled **"Hours"** when the Book Hours feature is ON and
  **"Qty"** when OFF — same storage either way (`quantity`), so labor works exactly
  as before the feature. The hours still feed the tech-hours count under the hood;
  there's no "tech pay" wording on the advisor's labor field or row.
- **Package** type appears in the selector only when the **Packages** feature is ON
  (or the line is already a package). Picking a unit fills **Price** from
  `set_price`. **The advisor does NOT see or edit R&R hrs** — the line still
  **silently carries `rr_hours`** (see §3): on a new/changed unit it takes that
  unit's `default_rr_hours`; on a same-unit edit it **preserves the line's current
  value** (a manager may have adjusted it). R&R is the manager's, set in the
  **Rebuild Units & Prices** R&R Hrs column (see [[packages]]).
- **Parts margin** (`Sell − Cost`, and %) renders **live** in the window
  (`#cdLf_margin`). It is **INTERNAL** — never shown to the customer and never
  printed (see §4).

## 3. Saving — resilient write
`writeLineRow(payload, id)` (`advisor-board.html:5284`) inserts (add) or updates
(edit) `ro_line_items`, then updates `currentLines` in place and re-renders. If a
**new column isn't migrated yet** (`unit_cost`, `package_unit_id`, `rr_hours`,
`part_number`), the write catches the missing-column error, **strips those optional
columns, and retries once** so the core line still saves. New lines get
`sort_order = currentLines.length`. The old inline `onFieldChange` /
per-field auto-save is gone.

## 4. Cost / margin is INTERNAL — never printed
`unit_cost` and the computed margin exist for the shop only. `printRo` builds its
invoice from `description` / `part_number` / `quantity` / `unit_price` **only** — it
never reads `unit_cost`. The read-only row also shows only the sell price, not cost.
So cost/margin never reaches the customer estimate / RO / invoice.

## 5. What did NOT change
- **Totals/tax:** `recalcTotals()` / `roTotalNum()` unchanged — `Σ(qty×unit_price)`
  + tax on taxable lines (customer-exempt aware).
- **Print package fold-in:** package lines still print under Parts and fold into the
  Parts subtotal (see [[packages]] §4).
- **RO-level Book Hours field + the leaving-Estimate gate:** unchanged (see
  [[flat-rate-hours]] §8/§9). Reconciling the RO `book_hours` with per-line labor
  hours + package R&R hours into a tech-pay report is the **next** step.
- **`+ Card fee`** button still adds a non-taxable fee line directly (`addCardFee`).

## Known gaps & open questions (as of 2026-08-07)
- **`unit_cost` migration not yet applied** — parts cost/margin can be entered and
  shown live, but the cost won't persist until `20260807_ro_line_unit_cost.sql` is
  run (the line saves without it meanwhile).
- **Hours reconciliation is not built** — labor Hours (stored in `quantity`) and
  package `rr_hours` are captured but not yet summed against the RO's `book_hours`
  or rolled into a per-tech report (see [[flat-rate-hours]] §6).
- **Shop Supply / Hazmat** kept in the type selector (flat, like Fee) so nothing
  regresses from the old inline type dropdown; they prefill their RO&Pricing default.

## Where it lives in the code / schema
- **Schema:** `ro_line_items` (`migrations/20260716_ro_foundation.sql`) +
  `part_number` (`20260716_phase3_print_fields.sql`) + `package_unit_id`/`rr_hours`
  (`20260807_packages.sql`) + **`unit_cost`** (`20260807_ro_line_unit_cost.sql`,
  additive, unapplied). Anon + authenticated RLS via
  `20260801_office_auth_widen_step1_5.sql` (no policy change needed for the column).
- **Row render:** `advisor-board.html` `renderLines` (:4929), `LINE_TYPE_LABEL`
  (:4925).
- **Pop-up:** markup `#cdLineModal` (:1655); `openLineModal` (:5168),
  `renderLineFields` (:5197), `wireLineFields`, `packageUnitOptions` (:5150),
  `saveLineModal` (:5301), `writeLineRow` (:5284), `deleteLine` (:5401).
- **Totals / print (unchanged):** `recalcTotals` / `roTotalNum`; `printRo`
  labor/parts rows + fold-in.
- **Related docs:** [[packages]] (Package line + unit prices), [[flat-rate-hours]]
  (Book Hours field + gate; the tech-pay hours these feed), [[settings]] (RO &
  Pricing defaults).

## Session change log
- 2026-08-07 — Created. Replaced inline RO line-item editing with an **Add/Edit-Line
  pop-up**: read-only rows (type chip · desc · qty/hrs · unit $ · tax · line · pencil
  + ×), one window whose fields adapt per type (Labor with auto-Sell + tech-pay
  Hours, Parts with internal Cost/margin, Package with the grouped unit dropdown +
  R&R hrs, flat Fee/Shop Supply/Hazmat). Added `ro_line_items.unit_cost` (internal,
  never printed; migration `20260807_ro_line_unit_cost.sql`, additive, unapplied).
  Totals/tax math + print fold-in + the RO-level Book Hours field/gate all unchanged.
  Verified live on real ROs: read-only rows, add/edit/delete round-trip, labor
  auto-Sell, parts margin ($135 / 42.2%), package resolve (price 5720), totals
  intact, no JS errors.
- 2026-08-07 — Dropped "tech pay" wording from the advisor's LABOR line (pop-up
  label "Hours · tech pay" → "Hours"; removed the "· Nh tech pay" row annotation)
  and **removed the R&R hrs field from the advisor's PACKAGE pop-up** (now Unit /
  Price / Taxable only; also removed the "· R&R Nh" row annotation). The line still
  **silently carries `rr_hours`** — new/changed unit → unit's `default_rr_hours`,
  same-unit edit → preserves the line's current value (manager-owned). Data model +
  the settings R&R Hrs column unchanged. Verified live on a real RO: labor label
  "Hours", package pop-up has no R&R field, and a saved package line stored
  `rr_hours = 7.5` (the unit default) via DB read-back; test line cleaned up.
