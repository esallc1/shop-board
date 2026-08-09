# How Cost & Profit (Cockpit + Build Sheet) is wired

> Doc: `/docs/wiring/cost-profit.md`
> Last updated: 2026-08-09 — verified vs commit `c0c3f81` (+ this Step-2b shared
> parts library + vendor sweep, verified in-browser this session)
> Status: ✅ Step 1 (frame + relocation) + ✅ Step 2a (recipe + rates + live
> profit) + ✅ Step 2b (shared parts library + linked recipe lines + vendor
> bulk-cost sweep) BUILT, **always on — NO feature switch** (§1). Step 2a is live
> (`20260809_costlayer_unit_parts_rates.sql` applied); Step 2b migration
> `20260809_costlayer_parts_library.sql` is add-only + **NOT yet applied** — hand
> to Cris. NOT built: the Cockpit (Step 3), per-person roster / actual-vs-standard
> (Step 3).

## 0. In one line
A **"Cost & Profit"** sidebar group that **always shows** on the **Owner and
Bookkeeping boards** with two items — **Cockpit** (Step-3 placeholder) and **Build
Sheet** — where the Build Sheet is a three-tab workbench: **Units** (the relocated
"Rebuild Units & Prices" editor **plus** a per-unit rebuild-parts recipe and live
cost/profit/margin — §6), **Parts catalog & vendor pricing** (the shared parts
library + the vendor bulk-cost sweep — §8–§9), and **People & rates** (three
shop-level standard-cost rates — §7).

## 1. No feature switch (standing rule)
- **There is no toggle.** The group ships unconditionally; new features (this one,
  and Steps 2/3) ship through the **preview → eyeball → prod** flow, NOT behind a
  `shop_settings` flag. (History: Step 1 first shipped behind a
  `feature_cost_profit` switch; the switch was removed the same day when the team
  adopted the no-toggle rule.)
- **The `shop_settings.feature_cost_profit` column is DORMANT.** It was added by
  `migrations/20260809_feature_cost_profit_flag.sql` (additive boolean) and is now
  **unused** — no app code reads it. It is harmless and intentionally **not
  dropped** (no down-migration). Ignore it.

## 2. The sidebar group (Owner + Bookkeeping only)
- Markup: a plain `sidebar-group` (label "Cost & Profit") with two
  `sidebar-item`s: `data-view="cockpit"` 🎛️ and `data-view="buildsheet"` 🔧.
  Present in **`owner-board.html`** and **`bookkeeping-board.html`** only —
  Manager/Advisor boards are untouched. **Always visible** — no `display:none`, no
  reveal function.

## 3. The Build Sheet page — `shared/build-sheet.js`
- **One shared module** mounted on both boards: `BuildSheet.mount(container, { db })`.
  Self-contained (injects its own `<style>` once). Builds an inner **sub-tab bar**
  with three tabs and renders the active one:
  - **Units** (ACTIVE) → calls **`BoardSettings.renderRebuildUnits(pane, { db,
    costLayer })`** — the ONE shared copy of the Rebuild Units editor (§4) with the
    Build-Sheet-only cost layer bolted on via the `costLayer` provider (§6).
  - **Parts catalog & vendor pricing** → the shared parts library + vendor
    bulk-cost sweep (§8–§9).
  - **People & rates** → three standard-cost rate inputs (§7).
- **Mount points:**
  - Owner: `#buildsheet-root` inside `#view-buildsheet`; a click listener on the
    Build Sheet nav item calls `BuildSheet.mount`.
  - Bookkeeping: same `#buildsheet-root`; `activateView('buildsheet')` calls
    `BuildSheet.mount` (fresh Units list on each open).
- **`mount()` is idempotent** — the shell builds once (`dataset.bsheetBuilt`),
  and each call re-renders the active tab so the Units list is current.

## 4. Units tab = the relocated Rebuild Units editor (ONE copy)
- The editor logic lives in `shared/board-settings.js` as `renderUnitsEditor`
  (add/edit/delete `package_units`; Group / Unit / Set Price / Default R&R Hours;
  grouped-by-`group_label` view with the per-group "set price for whole group"
  bulk `Apply`). It is the SAME code the Settings "Rebuild Units & Prices" pane
  used before — extracted, not duplicated. Exposed as
  `BoardSettings.renderRebuildUnits(content, cfg)` for the Build Sheet.
- **Behavior is identical** to the old settings pane: same `package_units` table,
  same validation, same `setGroupPrice`/`addPackageUnit`/`savePackageUnit`/
  `deletePackageUnit`, and editing here reloads the module's package-unit cache
  (`loadPackageUnits`) so the RO "Package" dropdown stays current — exactly as
  before. See [[packages]] for the unit list itself and [[settings]] §4.2/§4.4.
- **No schema/data change:** Step 1 does NOT touch `package_units` columns or any
  saved RO. It is a relocation of an existing surface.

## 5. Settings ↔ Build Sheet handoff (no double home)
- The Settings "Rebuild Units & Prices" pane (`renderPackagesPane`) is a thin
  dispatcher gated purely on **whether the host board passed `onOpenBuildSheet`**
  (owner + bookkeeping do; GM/Advisor do not — no flag involved). When it did, the
  pane shows a one-line **"Moved to the Build Sheet"** redirect with an **Open
  Build Sheet** button (closes the modal, opens Build Sheet → Units). Otherwise it
  renders the classic inline editor (`renderUnitsEditor`).
- **Guarantee:** the editor is mounted in exactly ONE place at a time — Settings
  (a board with no Build Sheet) XOR the Build Sheet (a board that has one). This
  is why a module-level re-render is safe.
- **GM board is unchanged:** GM has money rights (so the Packages settings
  category can show) but no Build Sheet, so it never passes `onOpenBuildSheet` →
  the redirect branch is skipped → GM keeps the full inline editor. Verified
  in-browser this session.

## 6. The cost layer (Step 2a) — recipes + live profit, Build Sheet only
The Units tab bolts a per-unit **rebuild-parts recipe** and **live
cost/profit/margin** onto the shared editor **without duplicating it and without
touching GM/Advisor**. Mechanism: the shared `renderUnitsEditor` accepts an
optional **`opts.costLayer` provider object**, supplied ONLY by the Build Sheet
(`makeCostLayer(db)` in `shared/build-sheet.js`). GM/Advisor mount the editor with
no `costLayer`, so they render exactly as before (verified: no cost column, no
expand, no summary).
- **Provider contract** (all cost math + `unit_parts` access live in the provider,
  never in board-settings.js): `load()` warms rates + all recipe parts once;
  `summaryHtml(handle, ctx)` returns the collapsed row's compact
  `cost · profit · margin`; `renderRecipe(cell, handle, ctx)` fills the expanded
  parts editor + result box; `onRowInput(handle, ctx)` recomputes live as Set
  Price / R&R Hrs are typed; `onCollapse(handle)` drops the open panel. `handle =
  { unit, getLive(), setSummary(html) }` is built per row by `wireCostRow` in
  board-settings.js.
- **Recipe = `unit_parts`** (one row per part line): FK `package_unit_id` →
  `package_units(id)` `on delete cascade`, plus `qty`. A line is **either**:
  - a **standalone typed part** (`library_part_id` null) carrying its own
    `name`/`part_no`/`vendor`/`unit_cost` (Step 2a), OR
  - a **linked library line** (`library_part_id` set — Step 2b): it stores only
    the reference + `qty`; name/vendor/cost are read live from the shared library
    item (§8). Editing the library item's cost updates every linked line.
  Add/edit/delete in the expanded panel ("Add" for a typed line, "Add from
  library" for a linked one); each mutation reloads that unit's parts and
  re-renders the panel + collapsed summary (the panel stays open). See [[packages]].
- **Standard cost (per unit):**
  `Σ(part cost × qty) + (R&R Hrs × Standard R&R rate) + Rebuilder cost
   + (Set Price × Standard advisor %)`, where a part's cost is its typed
  `unit_cost` (standalone) or the library item's **effective per-unit cost**
  (linked): flat = `unit_cost`, bulk = `bulk_price ÷ bulk_qty` (§8).
  **Profit** = Set Price − Standard cost. **Margin** = Profit ÷ Set Price. Shown
  in a result box in the expanded recipe AND compactly on the collapsed row.
- **Honest empty state:** a unit with **zero recipe parts** shows **"No cost set"**
  (never $0 profit) — parts presence is the signal that cost has been entered. The
  shop-level rates apply only once a unit has a recipe.
- **Live:** recipe edits recompute immediately; typing in Set Price / R&R Hrs
  updates the summary + result box on the fly (`onRowInput`); a row **Save**
  re-renders the whole editor (collapsing panels) with fresh numbers.

## 7. People & rates tab (Step 2a) — three standard-cost placeholders
`renderPeopleRates` (in `shared/build-sheet.js`) reads/writes three numeric
columns on the single `shop_settings` row: **Standard R&R rate** (`std_rr_rate`,
$/flagged hour), **Rebuilder cost** (`rebuilder_cost`, $/unit), **Standard advisor
%** (`std_advisor_pct`, % of sale). Defaults fabricate nothing: 0 / 0 / 2.5.
Saved via the anon path like every setting, then `BoardSettings.reloadShopSettings()`
so the Units cost math sees the new rates on next render.
- **INDEPENDENT of the live Advisor Commission engine** — these are Build-Sheet
  standard-cost assumptions only. They are **not** wired to
  `parts_margin_pct`/`package_margin_pct` or the per-advisor pay plan
  ([[advisor-commission]]); `std_advisor_pct` is a separate column.
- Read by the cost layer via `BoardSettings.getShopSettings()` (the three columns
  were added to `SHOP_DEFAULTS` + the reader; fail-safe to the defaults
  pre-migration).

## 8. Shared parts library (Step 2b) — reusable, linked items
`parts_library` holds reusable interchangeable parts (ATF, cleaner, common
hardware) entered once and **linked** into many recipes (not copied). Managed on
the **Parts catalog & vendor pricing** tab (`renderPartsCatalog` in
`shared/build-sheet.js` — one editable card per item + an add card).
- **Two cost modes:** `cost_mode` = `flat` (a per-unit `unit_cost`, e.g. a seal
  $4.25 ea) or `bulk` (`bulk_price ÷ bulk_qty`, e.g. an ATF drum $1,268 ÷ 200 qt =
  $6.34/qt, with `bulk_unit` as the label). The per-unit cost is **computed in the
  app** (`libUnitCost`), never stored; the card shows it live as you type.
- **Linked, not copied:** a recipe line with `unit_parts.library_part_id` set reads
  name/vendor/cost from the item. Edit the item's cost (or its drum price) once →
  every recipe using it recomputes (`effectiveUnitCost` resolves it at compute
  time). Standalone Step-2a lines are unaffected.
- **Delete is blocked while in use:** deleting a library item first counts
  referencing `unit_parts` rows; if any, it refuses ("Used in N recipe lines —
  remove those first"). The FK is `on delete set null` only as a DB backstop.
- **Pre-migration fallback:** the tab shows a "run the migration" note, and the
  Units "Add from library" control is hidden, until
  `20260809_costlayer_parts_library.sql` is applied.
- **RLS covers anon AND authenticated:** a signed-in office owner runs as the
  `authenticated` role (Supabase Auth via `office-login.html` — see
  [[office-auth]]), not `anon`. Every cost-layer table therefore needs BOTH an
  anon policy and an `authenticated` twin (per the 2026-08-01 widen), or the
  signed-in owner goes blind / can't write. `parts_library` originally shipped
  anon-only, which RLS-blocked the owner's inserts; the authenticated twin was
  added by `20260809_costlayer_rls_authenticated_fix.sql` (and inline in the
  canonical `20260809_costlayer_parts_library.sql` for fresh rebuilds).

## 9. Vendor bulk-cost sweep (Step 2b) — the inflation fix
On the same tab: pick a **vendor**, enter **±X%**, **Apply** → raises the cost of
every part tagged to that vendor (`applyVendorSweep`):
- **Standalone recipe lines** (`unit_parts` where `vendor = V` and
  `library_part_id` null) → `unit_cost × (1 + X/100)`.
- **Library items** where `vendor = V` → flat: `unit_cost ×`; bulk: **`bulk_price ×`**
  (so the per-unit cost recomputes, and every linked recipe line follows).
- **Impact summary:** "Vendor ±X% → N parts updated across M units." Every affected
  unit's Cost/Profit/Margin reflects the change when the Units tab is reopened
  (it remounts + reloads the library on each open).
- **Undo last:** the sweep captures each changed row's old value in memory; **Undo
  last** writes them back and re-renders. (In-memory — an immediate undo, not a
  persistent history.)

## Known gaps & open questions (as of 2026-08-09)
- **Step 2b migration unapplied:** until `20260809_costlayer_parts_library.sql`
  runs, the Parts catalog shows a "run the migration" note and the "Add from
  library" control is hidden; standalone Step-2a recipes keep working. All add-only.
- **Vendor sweep updates row-by-row** (PostgREST anon has no arithmetic UPDATE), so
  a vendor with many parts is several small writes; undo is in-memory (lost on
  reload). Fine at shop scale.
- **Not built:** the Cockpit (Step 3) and a per-person roster / actual-vs-standard
  (Step 3).
- **`std_advisor_pct` is a percentage number** (2.5 = 2.5%), divided by 100 in the
  math — distinct from the commission engine's fraction-stored margins.
- **Dormant column:** `shop_settings.feature_cost_profit` still exists (from the
  original flag) but is read by nothing — intentionally left, not dropped (§1).

## Where it lives in the code
- **Build Sheet module:** `shared/build-sheet.js` — `BuildSheet.mount`, the tab
  shell, the cost layer (`makeCostLayer`/`loadCostContext`/`computeCost`/
  `effectiveUnitCost`/`libUnitCost`/`summaryHtml`/`resultBoxHtml`/`renderRecipe`/
  `onRowInput`), the shared parts library + vendor sweep (`renderPartsCatalog`/
  `wireLibCards`/`applyVendorSweep`/`undoLastSweep`), and `renderPeopleRates`.
- **Shared Units editor:** `shared/board-settings.js` — `renderUnitsEditor`
  (guts; accepts `opts.costLayer`), `wireCostRow` (per-row cost UI + handle),
  `renderPackagesPane` (redirect-or-editor dispatcher, gated on `onOpenBuildSheet`),
  CRUD, the `std_*` rate defaults + reader, exposed via
  `BoardSettings.renderRebuildUnits`. **Unchanged by Step 2b** (all 2b logic is in
  build-sheet.js) — GM/Advisor stay unchanged.
- **Cost schema (Step 2a):** `migrations/20260809_costlayer_unit_parts_rates.sql`
  — `unit_parts` (recipe lines, RLS mirrors `package_units`) + `shop_settings`
  `std_rr_rate`/`rebuilder_cost`/`std_advisor_pct`. **Applied.**
- **Cost schema (Step 2b):** `migrations/20260809_costlayer_parts_library.sql` —
  `parts_library` (RLS/realtime mirror `package_units`) + `unit_parts.library_part_id`
  (nullable FK, `on delete set null`). **Add-only, not yet applied.**
- **Owner board:** `owner-board.html` — the Cost & Profit `sidebar-group`,
  `#view-cockpit`, `#view-buildsheet` (`#buildsheet-root`), `openBuildSheet`,
  `BoardSettings.init({ onOpenBuildSheet, … })`, `<script src="shared/build-sheet.js">`.
- **Bookkeeping board:** `bookkeeping-board.html` — same markup + `openBuildSheet`;
  `activateView('buildsheet')` mounts the Build Sheet; `onOpenBuildSheet:
  () => activateView('buildsheet')`.
- **Dormant column:** `migrations/20260809_feature_cost_profit_flag.sql` (the flag
  that used to gate this; now unused — §1).
- **Related docs:** [[packages]] (the unit list + RO "Package" line),
  [[settings]] (Features switchboard + the money-gated Rebuild Units category),
  [[flat-rate-hours]] (R&R hours = the tech-pay side of a unit).

## Session change log
- 2026-08-09 — **Fixed a Step-2b RLS bug: `parts_library` inserts blocked for the
  signed-in owner.** Root cause: the office owner runs as the `authenticated` role
  (Supabase Auth via office-login.html), but `parts_library` shipped with only a
  `to anon` policy (it was created after the 2026-08-01 office-auth widen and not
  in its list), so the authenticated owner had no applicable policy → INSERT/SELECT
  RLS-blocked ("violates row-level security policy"). Fix: add the `authenticated`
  twin policy (same access, no broader) to `parts_library` + `unit_parts`, mirroring
  the widen — `20260809_costlayer_rls_authenticated_fix.sql` (add-only, hand-run) and
  inline in the canonical 2b migration for fresh rebuilds. Add-only; no data or other
  tables touched. See [[office-auth]] and §8.
- 2026-08-09 — **Built Step 2b — cost layer, part 2 (shared parts library + vendor
  sweep).** Add-only migration `20260809_costlayer_parts_library.sql` (**unapplied**):
  `parts_library` (reusable items, flat or bulk-priced; RLS/realtime mirror
  `package_units`) + `unit_parts.library_part_id` (nullable FK, on delete set null).
  Filled the **Parts catalog & vendor pricing** tab: library CRUD (`renderPartsCatalog`,
  bulk `price ÷ size → computed per-unit`) + the vendor bulk-cost sweep
  (`applyVendorSweep`/`undoLastSweep`: pick vendor + %, raises standalone recipe
  lines AND library items — bulk raises the drum price — with an impact summary and
  in-memory undo). Recipes gained **linked library lines** ("Add from library":
  `library_part_id` + qty; name/vendor/cost read live from the library so one edit
  recomputes everywhere) alongside standalone typed lines. Delete of an in-use
  library item is blocked. **All Step 2b logic is in `shared/build-sheet.js`** —
  `board-settings.js` is byte-unchanged, so GM/Advisor are untouched. Verified
  in-browser (linked-line cost from a bulk item = $6.34/qt, sweep math bulk/flat/
  standalone, impact summary, live recompute, undo restore, pre-migration
  fallbacks). Cockpit (3) + per-person roster (3) NOT built. See [[packages]].
- 2026-08-09 — **Built Step 2a — cost layer, part 1 (enter parts + see live profit).**
  Add-only migration `20260809_costlayer_unit_parts_rates.sql` (**unapplied**):
  `unit_parts` recipe table (RLS/realtime mirror `package_units`, FK on delete
  cascade) + three `shop_settings` rate columns (`std_rr_rate`/`rebuilder_cost`/
  `std_advisor_pct`, defaults 0/0/2.5). `shared/build-sheet.js` gained the cost
  layer + the real **People & rates** tab; `renderUnitsEditor` gained an optional
  `opts.costLayer` provider (Build-Sheet-only) + `wireCostRow`, so each unit row
  expands to a parts recipe and shows live cost/profit/margin (collapsed summary +
  expanded result box). Standard cost = Σ(part×qty) + R&R Hrs×rate + rebuilder +
  price×advisor%. No-recipe → honest "No cost set". GM/Advisor unchanged (no
  `costLayer`). Verified in-browser (exact math, live price recompute, honest empty
  state, GM has no cost column). Parts library/vendor sweep (2b), Cockpit (3), and
  per-person roster (3) NOT built. See [[packages]], [[settings]].
- 2026-08-09 — **Removed the feature switch (same day, follow-up).** New standing
  rule: features ship via preview → prod, not behind a toggle. Dropped the
  `cost_profit` `FEATURE_FLAGS` entry + its `SHOP_DEFAULTS`/`getShopSettings`
  reader; the Cost & Profit group now shows unconditionally on both boards (no
  `refreshCostProfitNav`/`display:none`); the Settings redirect now keys only on
  `onOpenBuildSheet` (no flag). `shop_settings.feature_cost_profit` left dormant,
  NOT dropped. Verified in-browser: owner group always visible + always-redirect,
  Features pane back to 4 toggles, GM unchanged (inline editor, no group).
- 2026-08-09 — **Created. Built Cost & Profit Step 1 (frame + relocation only).**
  Added the `feature_cost_profit` owner switch (5th `FEATURE_FLAGS` entry, default
  OFF, `20260809_feature_cost_profit_flag.sql` — additive boolean, **unapplied**).
  New `shared/build-sheet.js` (3-tab Build Sheet: Units active + two "Coming in
  Step 2" stubs). Extracted the Rebuild Units editor into the shared
  `renderUnitsEditor` and exposed it as `BoardSettings.renderRebuildUnits`; the
  Settings "Rebuild Units & Prices" pane became a redirect-or-editor dispatcher
  (redirect only when the flag is ON *and* the board has a Build Sheet). Added the
  Cost & Profit sidebar group + Cockpit (Step-3 placeholder) and Build Sheet views
  to `owner-board.html` and `bookkeeping-board.html`, gated by
  `refreshCostProfitNav`. **No schema change beyond the flag; no `package_units`
  or RO change.** Verified in-browser on owner (group reveal, 3 tabs, 50-unit/8-group
  Units editor + bulk Apply, both stubs, Cockpit, Settings redirect ON with a
  working Open button, classic editor OFF) and confirmed GM/Advisor unchanged
  (GM keeps the inline editor even with the flag forced ON). Bookkeeping is a hard
  auth gate — structure + clean script execution verified; owner eyeballs it
  logged-in on the preview.
