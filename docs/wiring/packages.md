# How Packages (unit prices + the Package RO line) is wired

> Doc: `/docs/wiring/packages.md`
> Last updated: 2026-08-09 — verified vs commit `1d64041` (+ Cost & Profit Step 2a:
> a cost-side `unit_parts` recipe table now references `package_units` — see below)
> Status: ✅ BUILT, behind an owner switch (`feature_packages`, default OFF).
> Migration `20260807_packages.sql` has since been **applied** and the switch turned
> **ON** — confirmed live 2026-08-07: `feature_packages` true, the `package` line
> type present, and **50 real units across 8 groups** resolving their set price in
> the RO line pop-up. (The default-OFF safety + owner gating were verified when it
> was still off in prior sessions.)

## 0. In one line
A shop-set list of **package units** (e.g. `6L80` = $4950 set price, 6.5 default
R&R hours) that the RO builder drops onto a new **"Package"** line type: the set
price is the **customer price** (qty 1, taxable, editable per job); the R&R hours
are **tech-pay only** (never added to the price) and are **manager-owned** — set in
the Rebuild Units & Prices R&R Hrs column and carried silently on the line; the
advisor never sees or edits them. The whole thing is gated by an owner **Packages**
switch, default OFF — when off, the RO builder and settings look exactly like before.

## 1. The master switch (owner-controlled, default OFF)
- **Flag:** `shop_settings.feature_packages boolean not null default false`
  (migration `20260807_packages.sql`). Rides the existing single-row
  `shop_settings` table — same anon RLS, no new switch table. Second entry in the
  `FEATURE_FLAGS` registry (see [[settings]] §4.1 and [[flat-rate-hours]] §9 for
  the first, Book Hours).
- **Flip it:** owner-only **Features** pane (`renderFeaturesPane`), same as Book
  Hours. **Fail-safe OFF:** `getShopSettings().feature_packages` returns false when
  the column is missing (pre-migration) or the read fails.
- **What OFF suppresses:** (a) the **Packages** settings category, and (b) the
  **Package** option in the RO line-type dropdown. Nothing else changes.

## 2. The "Rebuild Units & Prices" editor (money-gated + feature-gated)
> **As of 2026-08-09 this editor can live in TWO places** — but it is ONE shared
> copy (`renderUnitsEditor` in `shared/board-settings.js`, exposed as
> `BoardSettings.renderRebuildUnits`). Behavior below is unchanged; only its home
> can move. See [[cost-profit]] and [[settings]] §4.4.
- **Home A — Settings inline editor (GM board):** the **Rebuild Units & Prices**
  pane in the shared settings modal (`renderPackagesPane`; category id still
  `packages`), visible when **`canEditShopMoney && feature_packages`** — the money
  gate as RO & Pricing, AND only when the Packages switch is on. Shown on boards
  **without** a Build Sheet (GM); advisor cannot see it.
- **Home B — Build Sheet → Units (Owner + Bookkeeping):** those boards host the
  Cost & Profit → Build Sheet, so the editor lives in its Units tab and the
  Settings pane becomes a one-line "Moved to the Build Sheet" redirect. This is
  **unconditional now — no feature switch** (see [[cost-profit]] §1). Same
  `package_units` data, same CRUD, same bulk group price.
- **Table:** `public.package_units` — `group_label` (nullable organizing tag),
  `unit_code` (the dropdown label, e.g. `6L80`), `set_price` (customer price),
  `default_rr_hours` (nullable tech-pay default), `active` (default true),
  timestamps. Anon-full-access RLS + realtime, mirroring every CrisData settings
  list.
- **Grouped view + bulk price:** the list is rendered **grouped by `group_label`**
  — named groups first (alphabetical) each under a heading, blank/ungrouped units
  last. Each named-group heading has a **"Set price for whole group"** shortcut
  (`setGroupPrice`) that writes one price to **every** unit in that group
  (`update … where group_label = <group>`). It's a convenience only — each unit
  keeps its own `set_price`, and per-unit edits still work; units that share a
  group merely tend to share a price. Every row also has an editable **Group**
  field, so a unit can be moved between groups.
- **CRUD:** add / edit / **hard-delete** rows (`addPackageUnit` / `savePackageUnit`
  / `deletePackageUnit`), all carrying `group_label`. Deleting a unit that a job
  already used does **not** rewrite that job — see §4 (resolve-and-store +
  `on delete set null`).
- **Read path for the RO:** warmed on init like payment methods
  (`loadPackageUnits`); the RO Board reads active units via
  `BoardSettings.getPackageUnits()` (returns `[]` pre-migration, so the dropdown
  is simply empty, never an error).

## 3. RO builder — the Package line type
> As of 2026-08-07 the RO line editor is an **Add/Edit-Line pop-up** (see
> [[ro-line-items]]); the Package fields now live in that window, not inline. The
> mechanics below are unchanged — only the surface moved.
- **Line type:** `ro_line_type` enum gains **`package`** (additive
  `alter type ... add value`). The type `<select>` in the pop-up includes Package
  only when the feature is on — `lineTypeOptions()` appends it (or when the line
  being edited is already a package).
- **The Package fields (in the pop-up)** — **Unit, Price, Taxable only**:
  - **Unit** → a dropdown of the active units, **grouped into `<optgroup>`s by
    `group_label`** (named groups alpha-first, ungrouped last) so the advisor scans
    by group but still picks an individual unit (`packageUnitOptions()`). A
    stored-but-deleted unit stays selectable so the name still shows.
  - **Price** → editable (the effective price). **Qty** is fixed at 1 on save.
    **Taxable** → a checkbox, default on.
  - **No R&R hrs field** — the advisor does not see or edit R&R hours (as of
    2026-08-07). R&R is the **manager's**, set in the Rebuild Units & Prices
    **R&R Hrs** column (§2) and adjustable on the manager side later.
- **Picking a unit** copies `set_price` → the Price field (editable after — bump it
  for one job without touching settings). On save the line stores
  `package_unit_id`, `description = unit_code`, `quantity = 1`, `taxable`, and
  **silently carries `rr_hours`**: a new/changed unit takes that unit's
  `default_rr_hours`; a same-unit edit **preserves the line's current** `rr_hours`
  so a manager-adjusted value is never clobbered. `rr_hours` still never enters the
  price math (§4).

## 4. Price vs pay — the one rule that keeps it safe
- **Customer price** = `Σ(quantity × unit_price)` over `ro_line_items`, unchanged.
  A package line contributes `1 × unit_price` to the subtotal + tax if taxable —
  handled by the generic on-screen `recalcTotals()`, the customer-history
  `totalsByRo` (both sum every line generically), and the close archive (which
  rolls non-labor into its "parts" bucket).
- **Tech pay** = `ro_line_items.rr_hours` — a **separate column that is never
  summed into any total**. It is the pull/install credit, captured now; the
  tech-hours rollup + report is the next step.
- **Print:** `printRo` (now a thin wrapper over the shared builder `shared/ro-invoice.js`,
  see [[ro-invoice]]) sums by category, so package lines are **folded into the
  Parts section and the Parts subtotal** (`partsTotal = catSum('parts') +
  catSum('package')`, `partsLines` includes package) so the printed rows and total
  agree. `rr_hours` is never printed.
- **Deleting a settings unit never rewrites a built job:** the line stored its own
  `description` / `unit_price` / `rr_hours` at pick time; the FK is
  `on delete set null`, so the line keeps its numbers and just loses the link.

## 5. Persistence (per package line, on `ro_line_items`)
- `package_unit_id uuid` → `package_units(id)` `on delete set null` (which unit).
- `rr_hours numeric` (nullable) — the effective tech-pay R&R hours for this job.
- Plus the shared columns it reuses: `line_type='package'`, `description`
  (unit code), `unit_price` (effective price), `quantity` (1), `taxable`.
- Pre-migration writes to `package_unit_id` / `rr_hours` degrade quietly via
  `isMissingColumn` (a warning, no crash), same pattern as `part_number`.

## Known gaps & open questions (as of 2026-08-07)
- **Tech-hours rollup + report not built** — `rr_hours` (package pull/install) and
  `book_hours` (the job's ALLDATA hours) are both captured but not yet summed into
  a per-tech pay report (the next slice; see [[flat-rate-hours]] §6).
- **`unit_code` is not unique** — the settings list allows duplicate codes; the
  dropdown would show both. Add a unique constraint later if that becomes a
  problem.
- **Financial Pulse / bookkeeping** don't bucket by `line_type` today, so package
  price flows through their generic sums correctly — but if a future report
  category-splits lines, `package` must be mapped explicitly.
- **Package COST is now capturable** — `package_units.unit_cost` (per-unit rebuild cost,
  added by `migrations/20260808_advisor_commission.sql`, additive/nullable) so the Advisor
  Commission engine can derive package **gross profit** (`set_price − unit_cost`), falling
  back to an assumed package margin until costs are entered. See [[advisor-commission]] §1.
  It's a **pay/GP** field only — never in the customer price (§4).
- **Cost-side recipe (Cost & Profit Step 2a):** a new `unit_parts` table (one row per
  rebuild-part line: name/part_no/vendor/unit_cost/qty) references `package_units(id)`
  `on delete cascade`. It feeds the Build Sheet's standard-cost/profit estimate only —
  it does **not** touch `package_units` fields, the customer price, or any RO. Full wiring
  in [[cost-profit]] §6; migration `20260809_costlayer_unit_parts_rates.sql` (add-only).
  (Distinct from `package_units.unit_cost` above, which the commission engine uses.)

## Where it lives in the code / schema
- **Schema:** `migrations/20260807_packages.sql` — `ro_line_type` +`package`;
  `package_units` table (+ RLS + realtime + `updated_at` trigger);
  `ro_line_items.package_unit_id` / `rr_hours`; `shop_settings.feature_packages`.
- **Settings:** `shared/board-settings.js` — `FEATURE_FLAGS` `packages` entry
  (:88), `loadPackageUnits`/`getPackageUnits` (:220/:233), "Rebuild Units &
  Prices" category (:480), `renderPackagesPane` (grouped view, :703), `setGroupPrice`
  (bulk group price, :784), `addPackageUnit`/`savePackageUnit`/`deletePackageUnit`
  (:795+, all carry `group_label`). Exposed via `BoardSettings.getPackageUnits`.
- **RO builder (now in the Add/Edit-Line pop-up — see [[ro-line-items]]):**
  `advisor-board.html` — `packagesFeatureOn`/`packageUnits`, `lineTypeOptions`, the
  grouped `packageUnitOptions()` dropdown, and resolve-and-store + save in
  `renderLineFields`/`wireLineFields`/`saveLineModal`; print fold-in in `printRo`.
- **Related docs:** [[ro-line-items]] (the line-item pop-up this lives in),
  [[settings]] (the Features switchboard + money gate), [[flat-rate-hours]] (Book
  Hours — the other tech-pay hours source, and the gate that shows the R&R field).

## Session change log
- 2026-08-09 — **Cost & Profit Step 2a added a cost-side `unit_parts` recipe table** that
  references `package_units(id)` (on delete cascade) — per-unit rebuild-part lines feeding
  the Build Sheet's standard-cost/profit estimate. Does NOT alter `package_units`, the
  customer price, or any RO. Migration `20260809_costlayer_unit_parts_rates.sql` (add-only,
  RLS mirrors `package_units`). Full wiring in [[cost-profit]] §6.
- 2026-08-09 — **The Rebuild Units editor was extracted + relocated to the Build Sheet**
  (Cost & Profit Step 1). `renderPackagesPane` → the shared `renderUnitsEditor`
  (exposed as `BoardSettings.renderRebuildUnits`); on the Owner / Bookkeeping boards it lives in
  Build Sheet → Units and the Settings pane redirects, GM keeps the inline editor (§2). Shipped
  **behind a `feature_cost_profit` switch, then the switch was removed the same day** — the
  relocation is now unconditional (no flag; see [[cost-profit]] §1). ONE copy, no behavior change to
  `package_units`, the RO "Package" line, or any saved job. See [[cost-profit]].
- 2026-08-07 — Created. Built Packages behind a `feature_packages` owner switch
  (default OFF, second FEATURE_FLAGS entry): a `package_units` settings table +
  money-gated Packages pane (add/edit/delete Unit / Set Price / Default R&R
  Hours), a `package` RO line type that resolve-and-stores a unit's price + hours
  onto the line (qty 1, taxable, editable price; R&R hrs field only when Book
  Hours is on and never in the price math), `ro_line_items.package_unit_id` /
  `rr_hours`, and a print fold-in so package lines total under Parts. Migration
  `20260807_packages.sql` written, **not yet applied**. Verified in-browser:
  default OFF, both Features toggles present, Packages category hidden while OFF,
  getPackageUnits fail-safe. Also fixed the "N/A (no labor)" label overflow on the
  Book Hours field.
- 2026-08-07 — Added **`package_units.group_label`** (nullable, folded into the same
  `20260807_packages.sql` STEP 2, additive `IF NOT EXISTS` — migration still not
  applied). Renamed the settings pane to **"Rebuild Units & Prices"**, rendered the
  unit list **grouped by `group_label`** (named groups alpha-first, ungrouped last)
  with a per-group **"Set price for whole group"** shortcut (`setGroupPrice`, writes
  one price to every unit in the group) and a per-row editable Group field; each
  unit still keeps its own `set_price`. The RO **Package dropdown** now renders as
  `<optgroup>`s by `group_label` (behavior otherwise unchanged — still picks an
  individual unit). Verified in-browser: no errors, grouping/order logic (named
  alpha-first, ungrouped last), Features toggle description updated. Grouped
  settings pane + optgroup dropdown verified live after the migration.
- 2026-08-07 — The RO line editor became an **Add/Edit-Line pop-up** ([[ro-line-items]]);
  the Package fields moved into that window (§3 updated). Mechanics unchanged — the
  grouped unit dropdown (`packageUnitOptions`), resolve-and-store, and print fold-in
  all still hold. Verified live: package type in the pop-up shows the 8-optgroup / 50-unit
  dropdown and resolves the set price on select. `renderLines`/`onFieldChange` refs in
  this doc replaced with the pop-up functions.
- 2026-08-07 — **Removed the R&R hrs field from the advisor's Package pop-up** (now
  Unit / Price / Taxable only) — R&R is now the manager's (Rebuild Units & Prices
  R&R Hrs column). The line still **silently carries `rr_hours`** (unit default on
  new/changed unit; preserves the current value on same-unit edit). Data model +
  settings pane unchanged. §3 updated; verified live (saved package line stored
  `rr_hours = 7.5` from the unit default, DB read-back).
