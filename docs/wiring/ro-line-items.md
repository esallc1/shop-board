# How RO line items (the Add/Edit-Line pop-up) are wired

> Doc: `/docs/wiring/ro-line-items.md`
> Last updated: 2026-09-18 — **§2a added: every number in the pop-up is now strict text**
> (`type="text" inputmode="decimal"` + `shared/line-qty.js`), replacing `type="number"`,
> which changed values on a mouse-wheel scroll / arrow key. Verified vs commit `663a982` (branch
> `feat/line-qty-text-inputs`, rebased onto `main` `cb4e2d8`); **shipped to prod at `baecd25`**
> (2026-09-18 — www/board/apex `/api/version` = `baecd25`, `advisor-board.html` +
> `shared/line-qty.js` byte-identical to git).
> §1, §2, §2a, Known gaps and Where-it-lives re-checked against the code (all line numbers
> re-pointed), and §2a driven in the REAL pop-up on `test.*` signed in as ZZ Test Advisor — see
> the change log.
> Previously: 2026-08-10 — verified vs commit `17d4b02` (+ the Package
> Description field change, verified in-browser on a real RO that session)
> Status: ✅ BUILT + verified live 2026-08-10. The line editor is a pop-up
> window (no inline row editing). Verified end-to-end on real ROs: read-only rows,
> add/edit/delete round-trip, labor auto-Sell, parts margin, package resolve,
> totals unchanged. New column `ro_line_items.unit_cost` migration
> (`20260807_ro_line_unit_cost.sql`) is **now applied** (verified live 2026-08-08: the
> column exists) — though costs are still sparse (1 of 28 parts lines had one), which is
> why the Advisor Commission engine falls back to an assumed parts margin (see
> [[advisor-commission]] §1).

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
- The Qty/Hrs column is a **70px display column** (`<th style="width:70px">`,
  `advisor-board.html:2233`) of plain text — `num(l.quantity)`, e.g. "14.25" needs ~37px.
  (Before `0b3870e`, 2026-08-07, it was an inline `<input type="number" step="0.01">` —
  that is the layout older bug reports describe.)
- `renderLines()` (`advisor-board.html:6386`) renders each `currentLines` row as
  **static cells** — no inputs. Type shows as a chip (`LINE_TYPE_LABEL`); the
  description cell appends only `#part_number` for parts. **No tech-pay / R&R
  annotations on the advisor's rows** — hours already show in the Qty/Hrs column,
  and R&R is the manager's (see §2). Each row wires a **pencil** →
  `openLineModal(line)` and a **×** → `deleteLine(id)` (now with a confirm).
- Everything downstream still reads the **data model** (`currentLines`), not the
  DOM, so `recalcTotals()` / `roTotalNum()` / the print fold-in are untouched.

## 2. The Add/Edit-Line pop-up
A single `.modal-overlay` `#cdLineModal` (`advisor-board.html:2554`), reusing the
shared modal + `.intake-field` styles. `openLineModal(line)`
(`advisor-board.html:6673`) sets `lineModalEditId` (null = add), fills the **Type**
`<select>` from `lineTypeOptions()`, and calls `renderLineFields()`
(`advisor-board.html:6730`) which paints the fields for the current type. Changing
the Type re-renders the fields; **Description + Taxable carry over** across type
switches (`captureLineCommon` → `lineModalDraft`). `saveLineModal()`
(`advisor-board.html:6888`) validates every number (§2a), builds the payload and writes it; Cancel / × / backdrop
close without saving.

### Fields per type (and how each maps to storage — math unchanged)
The customer total is always `Σ(quantity × unit_price) + tax`, so every type stores
into `quantity` / `unit_price`; type-specific extras use their own columns.

| Type | Fields shown | → `quantity` | → `unit_price` | Other columns |
|---|---|---|---|---|
| **Labor** | Description, **Hours** (labelled "Qty" when Book Hours OFF), Rate ($/hr, default = RO&Pricing labor rate), **Sell (auto = Hours×Rate, read-only)** + the **math line** under it (§2a), **Tech credit** (Book Hours ON only — defaults to the RO tech), Taxable | hours | rate | **`line_tech_id`** (null = RO tech) |
| **Parts** | Part #, Description, **Cost** (internal), **Sell**, Qty, Taxable | qty | sell | **`unit_cost` = cost** |
| **Package** | Unit (grouped `<optgroup>` dropdown), **Description** (customer-facing, default "R&R TRANSMISSION W/OVERHAUL", editable — right after Unit, before Price), Price (editable), Taxable — **no R&R field** | 1 | price | `package_unit_id`, `description`=**customer text** (blank → unit_code fallback), `rr_hours` (silent) |
| **Fee / Shop Supply / Hazmat** | Description, Amount (Shop Supply/Hazmat prefill their RO&Pricing default), Taxable | 1 | amount | — |

### 2a. Every number in the pop-up is strict text (`shared/line-qty.js`)
**Why:** the pop-up's numbers used to be `<input type="number">`, which **changes its own value**
when the mouse wheel scrolls over it (while focused) or an arrow key is pressed. Reproduced
2026-09-18 in Chrome 152 with the pop-up's exact markup + CSS: Hours **14 → 13.5** from scrolling
the pop-up toward Save (the pop-up didn't even scroll — the wheel went to the number); Parts Qty
**14 → 14.01** from one wheel tick (prod closed RO 6022 carries a `1.01` "PAN FILTER" line — left
as is, by decision); **14.25 + ↓ → 14** (step 0.5 snap); clicking into the prefilled **"1"** and
typing 14 gave **114**; a typed **"14,5"** had its comma dropped → **145**.

**Now:** all seven number fields — Labor **Hours/Qty** + **Rate**, Parts **Cost** + **Sell** +
**Qty**, Package **Price**, Fee/Shop Supply/Hazmat **Amount** — are rendered by `lfNum` as
`<input type="text" inputmode="decimal" autocomplete="off" data-lf-num>`: no spinner, no wheel or
arrow-key changes, and phones still get the decimal keypad. `wireLineNumbers` gives each one:
- **select-all on focus** (a mouseup guard stops a mouse click collapsing it to a caret), so
  typing *replaces* the prefilled "1" — verified with a real click: "1" → type 14 → `14`;
- a **red border** (`.cd-lf-bad`) while the text is something the parser will refuse.

**The parser** (pure, `shared/line-qty.js`, 10 tests in `shared/line-qty.test.js`):
- accepts `14`, `14.5`, `14.`, `.5`, and a decimal comma with 1–2 digits after it
  (`"14,5"` → 14.5, `"14,25"` → 14.25);
- **rejects everything else** — `1,250` (gets a "no thousands commas" hint), `$140`, `14 hrs`,
  `-2`, `1e3`, `1.2.3`, `14,5,0` …;
- rounds to **2 dp, half-up** (storage is `numeric(10,2)`; 14.125 → 14.13);
- `parseQty` (Hours / Qty): **required and > 0**;
- `parseMoney` (Rate, Cost, Sell, Price, Amount): **≥ 0**; blank keeps the old default — **0**,
  or **null** for the optional parts Cost.

**At Save** (`saveLineModal` → `lfRead`): every number field of the chosen type is parsed; any
refusal **blocks Save**, turns that field red, focuses the first bad one and shows
`<Label>: <reason>` in `#cdLineError` (e.g. "Hours: numbers only, like 14 or 14.5"). A **labor**
line over **24 h** (`HOURS_CONFIRM_ABOVE`; largest real prod labor line 2026-09-18 = 22 h) asks
**"Is 114 hours right?"** — Cancel returns to the Hours field without saving. If the module
failed to load, Save refuses with "The number checker didn't load — reload the page, then save."

**Live readouts** use the same parser, so they never show a half-read number: labor **Sell
(auto)** shows `—` while either side is invalid, the **math line** (`#cdLf_math`,
`laborMathLine`) reads **"14 h × $140 = $1,960.00"** ("14 × $140 = …" when the field is labelled
Qty), and the parts **Margin** shows `—`.

What did **not** change: storage, labels, the display table, totals/tax, print.

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
- **Package Description (customer-facing).** The Package window has a **Description**
  field (right after Unit, before Price) that **reuses the shared `description`
  column** — no new column. New/legacy lines pre-fill the default
  **"R&R TRANSMISSION W/OVERHAUL"** (`DEFAULT_PKG_DESC`); it's fully editable per
  line. On save, `description` = the typed text, or the **unit code** as a fallback
  when blank (so the row + printed invoice always have a sensible label, and legacy
  lines that stored the unit code keep working). The line table renders a Package
  row as **`<unit> — <description>`** (unit from `package_unit_id` via
  `unitCodeFromId`), falling back to just the unit when the description is blank or
  equals the unit code. The edit modal pre-fills the saved description (or the
  default for legacy/blank lines). The printed invoice shows `description` (the
  customer text) — an improvement over the old unit-code label. Package-specific:
  Labor / Parts / Fee are unchanged.
- **Parts margin** (`Sell − Cost`, and %) renders **live** in the window
  (`#cdLf_margin`). It is **INTERNAL** — never shown to the customer and never
  printed (see §4).
- **Tech credit (labor, Book Hours ON):** a `Tech credit` picker
  (`lineTechPickerHtml`, `advisor-board.html:6717`) whose value `""` = **inherit the
  RO's assigned tech** (stored as `line_tech_id = null`), or an employee id =
  **credit that tech** for this line's hours (the 2nd-tech-did-one-piece case).
  A labor row shows a muted `→ Name` when it's credited to a non-default tech.
  This feeds the weekly per-tech **Billed Hrs** rollup (see [[flat-rate-hours]] §10).

### Book Hours is a READ-ONLY auto-total (not typed)
The RO-level **Book Hours** field is no longer hand-typed — it's the **auto-total**
`Σ labor-line hours + Σ package R&R hours`, recomputed live as lines change and
persisted to `repair_orders.book_hours` (see [[flat-rate-hours]] §8). Kevin adjusts
on the **line** (a Labor line's Hours, or a Package line's R&R via settings) and the
total follows. So the line editor is where all hours are entered.

## 3. Saving — resilient write (surgical strip)
`writeLineRow(payload, id)` (`advisor-board.html:6869`) inserts (add) or updates
(edit) `ro_line_items`, then updates `currentLines` in place and re-renders. If a
not-yet-migrated OPTIONAL column (`unit_cost`, `package_unit_id`, `rr_hours`,
`part_number`, `line_tech_id`) makes the write fail, it strips **only the column the
error names** (`missingColumnName`, `advisor-board.html:6103`) and retries — so an
unmigrated `line_tech_id` never clobbers an already-migrated `unit_cost` /
`package_unit_id` / etc. (the earlier blanket-strip would have). New lines get
`sort_order = currentLines.length`. The old inline `onFieldChange` /
per-field auto-save is gone.

## 4. Cost / margin is INTERNAL — never printed
`unit_cost` and the computed margin exist for the shop only. `printRo` (now a thin wrapper
over the shared builder `shared/ro-invoice.js`, see [[ro-invoice]]) builds its
invoice from `description` / `part_number` / `quantity` / `unit_price` **only** — it
never reads `unit_cost`. The read-only row also shows only the sell price, not cost.
So cost/margin never reaches the customer estimate / RO / invoice.

## 5. What did NOT change
- **Totals/tax:** `recalcTotals()` / `roTotalNum()` — `Σ(qty×unit_price)` + tax on taxable
  lines (customer-exempt aware), **+ the live card fee** when switched on. Since 2026-09-18 both
  go through `shared/ro-totals.js` ([[card-fee]]).
- **Print package fold-in:** package lines still print under Parts and fold into the
  Parts subtotal (see [[packages]] §4).
- **The card fee is no longer a line.** The `+ Card fee` button / `addCardFee` (which inserted
  a one-time non-taxable fee line) was replaced 2026-09-18 by the per-RO **Card fee switch** in
  this card's header — a live totals row, not a stored line. See [[card-fee]]. A plain **Fee**
  line (towing, etc.) is still added through the Add-Line pop-up as before.

**Now CHANGED (Hours Engine Part 1):** the RO-level Book Hours field is a read-only
**auto-total** from the lines (above / [[flat-rate-hours]] §8), the leaving-Estimate
gate blocks on a **0 total** (not a blank input), labor lines carry a per-line
**`line_tech_id`**, and the weekly per-tech **Billed Hrs** rollup is now live on the
Manager board ([[flat-rate-hours]] §10).

## Known gaps & open questions (as of 2026-09-18)
- ~~`unit_cost` + `line_tech_id` migrations not yet applied~~ — both columns **exist on prod**
  (read-only API select of `unit_cost,line_tech_id`, 2026-09-18). The surgical strip (§3) stays
  as a safety net.
- **The Build Sheet's unit-parts qty fields** (`shared/build-sheet.js`, `type="number"`) have the
  same wheel/arrow behaviour — deliberately **out of scope** of §2a (different table,
  `unit_parts`), not fixed.
- The payments form's Amount (`#cdPayAmount`) and other `type="number"` fields on the board are
  outside this pop-up and unchanged.
- **Shop Supply / Hazmat** kept in the type selector (flat, like Fee) so nothing
  regresses from the old inline type dropdown; they prefill their RO&Pricing default.

## Where it lives in the code / schema
- **Schema:** `ro_line_items` (`migrations/20260716_ro_foundation.sql`) +
  `part_number` (`20260716_phase3_print_fields.sql`) + `package_unit_id`/`rr_hours`
  (`20260807_packages.sql`) + **`unit_cost`** (`20260807_ro_line_unit_cost.sql`) +
  **`line_tech_id`** (`20260807_ro_line_tech.sql`, uuid → `employees(id)`
  `on delete set null`; null = inherit RO tech) — the last two **additive, unapplied**.
  Anon + authenticated RLS via `20260801_office_auth_widen_step1_5.sql` (no policy
  change needed for the columns).
- **Row render:** `advisor-board.html` `renderLines` (:6386), `LINE_TYPE_LABEL`; display
  column header `Qty/Hrs` (:2233).
- **Pop-up:** markup `#cdLineModal` (:2554); `openLineModal` (:6673),
  `renderLineFields` (:6730), `wireLineFields` (:6833), `packageUnitOptions` (:6655),
  `lineTechPickerHtml` (:6717), `saveLineModal` (:6888),
  `writeLineRow`/`missingColumnName` (:6869/:6103), `deleteLine` (:6988).
- **Strict numbers (§2a):** `shared/line-qty.js` (+ `shared/line-qty.test.js`), loaded as
  `window.LineQty` by a module `<script>` next to the CustomerEdit loader; in
  `advisor-board.html`: `lfNum` (:6705), `wireLineNumbers` (:6804), `lfRead` (:6819),
  `lfLive`, CSS `.cd-lf-bad` / `.cd-lf-math`. The old `.cd-lines-table input/select` CSS
  (dead since `0b3870e`) was removed; `.cd-lines-table` itself is also used by `#cdPayTable`,
  whose rows have only buttons.
- **Totals / print (unchanged):** `recalcTotals` / `roTotalNum`; `printRo`
  labor/parts rows + fold-in.
- **Related docs:** [[packages]] (Package line + unit prices), [[flat-rate-hours]]
  (Book Hours field + gate; the tech-pay hours these feed), [[settings]] (RO &
  Pricing defaults).

## Session change log
- 2026-09-18 — Header: §2a **shipped to prod at `baecd25`** (was "not yet on prod").
- 2026-09-18 — **§2a: strict number fields.** All seven pop-up numbers (Hours/Qty, Rate, Cost,
  Sell, Qty, Price, Amount) went from `type="number"` to `type="text" inputmode="decimal"` with
  select-all on focus, a strict parser (`shared/line-qty.js`, 10 tests), Save blocked with an
  inline error on bad input, a >24 h labor confirm, and a live "14 h × $140 = $1,960.00" math
  line. Removed the dead `.cd-lines-table input` CSS. Line-number refs re-pointed; stale
  "migrations not applied" gap corrected. No storage / totals / print change. Branch
  `feat/line-qty-text-inputs`, unmerged; real-pop-up browser pass pending.
- 2026-09-18 (evening) — **§2a verified in the real pop-up** on `test.*` at `663a982` (served
  `advisor-board.html` + `shared/line-qty.js` byte-identical to git), signed in as ZZ Test Advisor
  (`authenticated`, sandbox), 1024px desk + 375px phone, on sandbox RO 6035 (no lines before, none
  after). Real clicks/typing: click into prefilled "1" + type 14 → `14` (was 114); 5 wheel ticks
  over the focused Hours → still `14` (was 13.5); ↓↓↑ → still `14`; "14,5" → 14.5 h, math line
  "14.5 h × $140 = $2,030.00"; "14,5,0" → red border, Sell `—`, Save blocked with "Hours: numbers
  only, like 14 or 14.5", 0 rows written; 114 → confirm text exactly "Is 114 hours right?"
  (confirm stubbed to Cancel for the pane) → nothing saved, focus back on Hours; saved 14.25 h →
  DB `quantity 14.25`, row "14.25 · $140.00 · $1995.00"; pencil → Rate wheel-up ×3 stayed 140,
  typed 139.5 → DB `unit_price 139.5`, math "14.25 h × $139.50 = $1,987.88"; all 7 number fields
  across all 6 types are `text`/`decimal`, zero `type=number` left in the pop-up; phone: Hours +
  Rate 146px each, math line fits, no sideways scroll. Test line deleted via its × (confirm
  stubbed to OK). Only console errors: the known sandbox avatar 400s.
- 2026-09-18 — Card fee became a live per-RO switch; RO totals here now come from `shared/ro-totals.js` (see [[card-fee]]). Branch `feat/card-fee-live`, unmerged.
- 2026-08-10 — **Package lines got a customer-facing Description field** (Add/Edit-Line
  pop-up, right after Unit before Price), pre-filled with the default
  "R&R TRANSMISSION W/OVERHAUL", editable per line. **Reuses the `description` column**
  (no migration): a Package line's `description` now holds the customer text (blank →
  unit-code fallback), and the line table renders `<unit> — <description>` (unit from
  `package_unit_id`), falling back to the unit alone when blank/legacy. Edit pre-fills
  the saved description; the printed invoice now shows the customer text. Package-only —
  Labor/Parts/Fee untouched. `advisor-board.html`: `unitCodeFromId`/`DEFAULT_PKG_DESC`,
  `renderLines`/`renderLineFields`/`saveLineModal` package branches. Verified in-browser
  on a real RO (add default → "41TE — R&R TRANSMISSION W/OVERHAUL", custom desc, blank →
  unit-only, edit prefill), test line cleaned up, no console errors. See [[packages]] §3.
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
- 2026-08-07 — **Hours Engine Part 1.** Book Hours became a read-only auto-total (§
  "Book Hours is a READ-ONLY auto-total"); added the labor **Tech credit** picker +
  `ro_line_items.line_tech_id` (`20260807_ro_line_tech.sql`, unapplied); made
  `writeLineRow` strip **only** the named missing column (`missingColumnName`), so an
  unmigrated `line_tech_id` no longer clobbers migrated columns. Verified live on real
  ROs: auto-total = labor + package-R&R hours (14h; 14→16→14 on an hours edit,
  reverted), `book_hours` persisted, tech picker defaults to the RO tech, and the
  surgical strip preserved `package_unit_id` on a package save. Per-tech Billed Hrs
  rollup on the Manager board is in [[flat-rate-hours]] §10.
