# How Cost & Profit (Cockpit + Build Sheet) is wired

> Doc: `/docs/wiring/cost-profit.md`
> Last updated: 2026-08-09 — verified vs commit `ee725cc` (+ this Cost & Profit
> Step-1 change, verified in-browser on the owner board this session)
> Status: ✅ Step 1 (frame + relocation) BUILT, behind an owner switch
> (`feature_cost_profit`, default OFF). Migration `20260809_feature_cost_profit_flag.sql`
> written, **NOT yet applied** — hand to Cris. Steps 2 (parts recipes / vendor
> costs) and 3 (Cockpit) are NOT built.

## 0. In one line
A new **"Cost & Profit"** sidebar group on the **Owner and Bookkeeping boards**
with two items — **Cockpit** (Step-3 placeholder) and **Build Sheet** — where the
Build Sheet is a three-tab workbench whose first tab (**Units**) is the existing
"Rebuild Units & Prices" editor *relocated out of Settings*, working identically.
The whole group is gated behind one owner switch, default OFF; when OFF nothing
changes anywhere.

## 1. The master switch (owner-controlled, default OFF)
- **Flag:** `shop_settings.feature_cost_profit boolean not null default false`
  (migration `20260809_feature_cost_profit_flag.sql`, additive, reuses the single
  anon-full-access `shop_settings` row — no new table, no RLS change). **Fifth**
  entry in the `FEATURE_FLAGS` registry (see [[settings]] §4.1).
- **Flip it:** owner-only **Features** pane (`renderFeaturesPane`), same as the
  other flags. **Fail-safe OFF:** `getShopSettings().feature_cost_profit` returns
  false when the column is missing (pre-migration) or the read fails, so both
  boards degrade to exactly today's behavior.
- **What OFF suppresses:** (a) the Cost & Profit sidebar group is hidden, and
  (b) the Settings "Rebuild Units & Prices" pane keeps the classic inline editor
  (no redirect). Nothing else changes.

## 2. The sidebar group (Owner + Bookkeeping only)
- Markup: a `sidebar-group` with `id="group-costprofit" style="display:none"`,
  label "Cost & Profit", two `sidebar-item`s: `data-view="cockpit"` 🎛️ and
  `data-view="buildsheet"` 🔧. Present in **`owner-board.html`** and
  **`bookkeeping-board.html`** only — Manager/Advisor boards are untouched.
- **Reveal:** `refreshCostProfitNav()` (defined on each board) sets the group's
  `display` from `BoardSettings.getShopSettings().feature_cost_profit`. It is
  wired into `onShopSettingsChanged` (the same hook that reveals the Commission
  nav), so the group appears/disappears when the switch loads or changes. First
  paint (before settings load) → hidden; fail-safe.

## 3. The Build Sheet page — `shared/build-sheet.js`
- **One shared module** mounted on both boards: `BuildSheet.mount(container, { db })`.
  Self-contained (injects its own `<style>` once). Builds an inner **sub-tab bar**
  with three tabs and renders the active one:
  - **Units** (ACTIVE) → calls **`BoardSettings.renderRebuildUnits(pane, { db })`** —
    the ONE shared copy of the Rebuild Units editor (see §4). Header suppressed
    (the tab bar already labels it).
  - **Parts catalog & vendor pricing** → stub, "Coming in Step 2".
  - **People & rates** → stub, "Coming in Step 2".
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
- The Settings "Rebuild Units & Prices" pane (`renderPackagesPane`) is now a thin
  dispatcher. When **`feature_cost_profit` is ON *and* the host board passed
  `onOpenBuildSheet`** (owner + bookkeeping do; GM/Advisor do not), the pane shows
  a one-line **"Moved to the Build Sheet"** redirect with an **Open Build Sheet**
  button (closes the modal, opens Build Sheet → Units). Otherwise it renders the
  classic inline editor (`renderUnitsEditor`).
- **Guarantee:** the editor is mounted in exactly ONE place at a time — Settings
  (flag OFF, or a board with no Build Sheet) XOR the Build Sheet (flag ON). This
  is why a module-level re-render is safe.
- **GM board is unchanged even when the flag is ON:** GM has money rights (so the
  Packages settings category can show) but no Build Sheet, so it never passes
  `onOpenBuildSheet` → the redirect branch is skipped → GM keeps the full inline
  editor. Verified in-browser this session.

## Known gaps & open questions (as of 2026-08-09)
- **Steps 2 & 3 not built:** the Parts and People tabs are stubs; the Cockpit is a
  placeholder. No cost math, parts recipes, vendor costs, or profit yet.
- **UI-level gate only:** like every feature flag, `shop_settings` is still
  anon-writable — the switch is not server-enforced (same posture as
  [[settings]] §4). Fine for a dark-shipped frame.
- **Migration unapplied:** flipping the switch before
  `20260809_feature_cost_profit_flag.sql` is applied shows the standard "needs its
  migration applied first" message and reverts (fail-safe).
- **Bookkeeping stored-tab edge case:** if a viewer's `sessionStorage` last-tab is
  `buildsheet` and the owner later turns the feature OFF, `activateInitialView`
  could still open the (now nav-hidden) Build Sheet view. Cosmetic only, inert
  content; acceptable for a dark-shipped Step 1.

## Where it lives in the code
- **Switch:** `shared/board-settings.js` — `FEATURE_FLAGS` `cost_profit` entry,
  `SHOP_DEFAULTS.feature_cost_profit`, `getShopSettings().feature_cost_profit`;
  migration `migrations/20260809_feature_cost_profit_flag.sql` (**unapplied**).
- **Build Sheet module:** `shared/build-sheet.js` (`BuildSheet.mount`).
- **Shared Units editor:** `shared/board-settings.js` — `renderUnitsEditor`
  (guts), `renderPackagesPane` (redirect-or-editor dispatcher), CRUD
  (`setGroupPrice`/`addPackageUnit`/`savePackageUnit`/`deletePackageUnit`),
  exposed via `BoardSettings.renderRebuildUnits`. `onOpenBuildSheet` init arg.
- **Owner board:** `owner-board.html` — `#group-costprofit`, `#view-cockpit`,
  `#view-buildsheet` (`#buildsheet-root`), `refreshCostProfitNav`/`costProfitOn`/
  `openBuildSheet`, `BoardSettings.init({ onOpenBuildSheet, onShopSettingsChanged })`,
  `<script src="shared/build-sheet.js">`.
- **Bookkeeping board:** `bookkeeping-board.html` — same markup + helpers;
  `activateView('buildsheet')` mounts the Build Sheet; `onOpenBuildSheet:
  () => activateView('buildsheet')`.
- **Related docs:** [[packages]] (the unit list + RO "Package" line),
  [[settings]] (Features switchboard + the money-gated Rebuild Units category),
  [[flat-rate-hours]] (R&R hours = the tech-pay side of a unit).

## Session change log
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
