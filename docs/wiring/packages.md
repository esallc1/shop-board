# How Packages (unit prices + the Package RO line) is wired

> Doc: `/docs/wiring/packages.md`
> Last updated: 2026-08-07 — verified vs commit `0deddaa`
> Status: ✅ BUILT this session, verified vs code. Behind an owner switch
> (`feature_packages`), **default OFF**. Migration `20260807_packages.sql` is
> written but **NOT yet applied** (Cris runs it by hand), so the feature reads
> OFF everywhere until then. Full ON behavior (the Package line dropdown, price/
> hours resolve, print) is verified live after the migration; default-OFF safety,
> the owner toggle, and the settings gating were verified in-browser this session.

## 0. In one line
A shop-set list of **package units** (e.g. `6L80` = $4950 set price, 6.5 default
R&R hours) that the RO builder drops onto a new **"Package"** line type: the set
price is the **customer price** (qty 1, taxable, editable per job); the R&R hours
are **tech-pay only** (never added to the price) and only appear when the Book
Hours feature is on. The whole thing is gated by an owner **Packages** switch,
default OFF — when off, the RO builder and settings look exactly like before.

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

## 2. Settings — "Rebuild Units & Prices" (money-gated + feature-gated)
- **Category:** the **Rebuild Units & Prices** pane in the shared settings modal
  (`shared/board-settings.js` `renderPackagesPane`; category id still `packages`),
  visible when **`canEditShopMoney && feature_packages`** — i.e. the same money
  gate as RO & Pricing (owner/GM), AND only when the switch is on. Manager (GM
  board) can edit it; advisor cannot.
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
- **Line type:** `ro_line_type` enum gains **`package`** (additive
  `alter type ... add value`). The type `<select>` includes Package only when the
  feature is on — `lineTypeOptions()` appends it (or when the line is already a
  package, so an existing package line keeps a valid option even if the switch is
  later turned off).
- **The row (package line):** in `renderLines()` a `line_type==='package'` row is
  special-cased:
  - **Description cell → a unit dropdown** (`data-field="package_unit_id"`) of the
    active units, **grouped into `<optgroup>`s by `group_label`** (named groups
    alpha-first, ungrouped units as plain options at the bottom) so the advisor
    scans by group but still picks an individual unit. Plus the stored unit if it
    was since deleted, so the name still shows.
  - **Qty → a static `1`** (no spinner). **Unit $ → editable** (the effective
    price). **Tax → a checkbox**, default on.
  - When Book Hours is ON, an **"R&R hrs · tech pay"** input
    (`data-field="rr_hours"`) renders under the dropdown. Hidden when Book Hours
    is off.
- **Picking a unit (resolve-and-store)** — `onFieldChange` on `package_unit_id`
  copies the unit onto the line: `description = unit_code`, `unit_price =
  set_price` (editable after — bump it for one job without touching settings),
  `quantity = 1`, `taxable = true`, and (only when Book Hours is on) `rr_hours =
  default_rr_hours`. Deselecting clears `package_unit_id` (price/desc stay).

## 4. Price vs pay — the one rule that keeps it safe
- **Customer price** = `Σ(quantity × unit_price)` over `ro_line_items`, unchanged.
  A package line contributes `1 × unit_price` to the subtotal + tax if taxable —
  handled by the generic on-screen `recalcTotals()`, the customer-history
  `totalsByRo` (both sum every line generically), and the close archive (which
  rolls non-labor into its "parts" bucket).
- **Tech pay** = `ro_line_items.rr_hours` — a **separate column that is never
  summed into any total**. It is the pull/install credit, captured now; the
  tech-hours rollup + report is the next step.
- **Print:** `printRo` sums by category, so package lines are **folded into the
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

## Where it lives in the code / schema
- **Schema:** `migrations/20260807_packages.sql` — `ro_line_type` +`package`;
  `package_units` table (+ RLS + realtime + `updated_at` trigger);
  `ro_line_items.package_unit_id` / `rr_hours`; `shop_settings.feature_packages`.
- **Settings:** `shared/board-settings.js` — `FEATURE_FLAGS` `packages` entry
  (:88), `loadPackageUnits`/`getPackageUnits` (:220/:233), "Rebuild Units &
  Prices" category (:480), `renderPackagesPane` (grouped view, :703), `setGroupPrice`
  (bulk group price, :784), `addPackageUnit`/`savePackageUnit`/`deletePackageUnit`
  (:795+, all carry `group_label`). Exposed via `BoardSettings.getPackageUnits`.
- **RO builder:** `advisor-board.html` — `packagesFeatureOn`/`packageUnits`
  (:3645/:3647), `lineTypeOptions` (:3664), package row in `renderLines` with the
  optgroup-by-group_label dropdown (:4907), resolve-and-store in `onFieldChange`
  (:5180), print fold-in (:5621).
- **Related docs:** [[settings]] (the Features switchboard + money gate),
  [[flat-rate-hours]] (Book Hours — the other tech-pay hours source, and the gate
  that shows the R&R-hours field).

## Session change log
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
