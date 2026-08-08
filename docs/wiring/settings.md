# How Settings is wired (and the proposed role-gated hub)

> Doc: `/docs/wiring/settings.md`
> Last updated: 2026-08-08 — verified vs commit `8c93cee` (merged to main)
> Status: ✅ §0–§4 (today's wiring) verified vs code this session — read against
> `shared/board-settings.js`, `migrations/20260716_shop_settings.sql`, `crisdata.html`, the four
> board `BoardSettings.init` calls, and `api/announcement.js`. **§4.1 (the owner Features
> switchboard, now two flags) and §4.2 (the money+feature-gated "Rebuild Units & Prices" category) are BUILT.**
> **§5–§10 remain a PROPOSED architecture — NOT built, pending approval.**

## 0. In one line
Settings today is **one shared modal** (`shared/board-settings.js`) that reads/writes a **single
`shop_settings` row + the `employees` row** with the **anon key**, and whose edit rights are
**hardcoded per board** (owner/gm can edit money, advisor can't) — there is **no per-viewer role
gate and no server-side enforcement**, so "hidden" today means "removed from the UI", not
"inaccessible."

---

# PART A — How it works TODAY (verified)

## 1. Storage — where the values live
- **Shop / money / ops settings → `public.shop_settings`** (migration
  `20260716_shop_settings.sql`): a **single fixed-id row** (`00000000-0000-0000-0000-000000000001`).
  Columns actually present:
  - `tax_rate` (fraction, default 0.07), `default_labor_rate` ($/hr, nullable),
    `default_diag_fee` ($, nullable), `card_fee_pct` (fraction, default 0.03 — the shop's live
    value is **4%**, set in-app), `shop_supplies_default` ($ flat), `hazmat_default` ($ flat),
    `show_tech_on_ro` (bool).
  - **Feature switches** (`20260807_feature_book_hours_flag.sql`, `20260807_packages.sql`,
    `20260808_advisor_commission.sql`, `20260808_bk_ro_detail_flag.sql`): `feature_book_hours`,
    `feature_packages`, `feature_advisor_commission`, and `feature_bk_ro_detail` (all bool,
    `not null default false`) — the master on/off switches for the Book Hours, Packages, Advisor
    Commission, and Bookkeeping RO Detail features (§4.1). One boolean column per switch; additive,
    no new table, no RLS change. The commission migration also adds the assumed-margin fallbacks
    `parts_margin_pct` / `package_margin_pct` (nullable; see §4.3).
- **Package unit prices → `public.package_units`** (migration `20260807_packages.sql`): the
  shop-set list backing the RO "Package" line — `group_label` (nullable organizing tag),
  `unit_code`, `set_price`, `default_rr_hours`, `active`, timestamps. Anon-full-access RLS +
  realtime, same pattern as `payment_methods`. Edited in the §4.2 "Rebuild Units & Prices" pane
  (grouped by `group_label`, with a bulk "set price for whole group" shortcut); read by the RO via
  `BoardSettings.getPackageUnits()`. See [[packages]].
  - **Shop Profile** (added by `20260716_phase3_print_fields.sql`): `shop_name`, `address_line`,
    `city_state_zip`, `phone`, `email`, `website`, `logo_url`, `mv_number`, `legal_terms`.
- **My Profile → `public.employees`**: display `name`, `photo_url` / `background_photo_url`
  (avatar + board background). Per-person, not shop-wide.
- **Read/write path:** ALL direct from the browser with the **anon/publishable key**.
  `shop_settings` is **RLS anon-full-access** (same posture as `parts_orders` / `core_charges`).
  `BoardSettings.loadShopSettings()` does `db.from('shop_settings').select('*')`;
  `saveShopSettings()` does `db.from('shop_settings').update(...).eq('id', <fixed id>)`. No
  server endpoint is involved in reading or writing settings today.
- **Resilience:** `getShopSettings()` falls back to defaults (tax 0.07) if the row/table is
  missing, so boards never break pre-migration.

## 2. The Settings modal — where it's defined & invoked
- **Defined:** `shared/board-settings.js` — `window.BoardSettings`. A category layout (left nav
  + right pane), self-injecting its own `<style>` + modal markup. Categories are built in
  `getCategories()` as a `cats` array of `{ id, label, icon, visible, render }` and painted by
  `renderPanes()`; today's four: **My Profile** (`renderMyProfilePane`), **Shop Profile**
  (`renderShopProfilePane`), **RO & Pricing** (`renderRoPricingPane`), **Payments**
  (`renderPaymentsPane`). An optional board-specific `extra` category exists via `onOpenExtra`.
- **Invoked on four boards** via `BoardSettings.init({ ... })`:
  | Board | `canEditShopMoney` | `canEditShopOps` |
  |---|---|---|
  | `owner-board.html` | **true** | true |
  | `gm-board.html` | **true** | true |
  | `advisor-board.html` | **false** | true |
  | `bookkeeping-board.html` | (money false; has its own extra category) | — |
- **The gate today is `canEditShopMoney`, hardcoded per board.** Shop Profile / RO & Pricing /
  Payments render only when it's true. So **which board you open decides your rights**, not who
  you are. (`visible: canEditShopMoney` in the `cats` array.)

## 3. Identity & roles TODAY — the crux
- **There IS a real login:** `crisdata.html` is the PIN hub — phone + PIN verified against
  `employees` (`phone`,`pin`,`active`), then it routes by `employees.role` to that role's board
  (`ROLE_DEST`: tech→my-numbers, advisor→advisor-board, manager→gm-board, owner→owner-board,
  bookkeeping→bookkeeping-board) with a `?u=phone&p=pin` pass-through.
- **Each board resolves the viewer:** `captureSessionAndGreet()` takes the pass-through phone (or
  a restored `localStorage` phone), looks up `employees` → `{ id, name, role, photo_url }`, and
  sets `CURRENT_EMPLOYEE_ID` + `CHAT_IDENTITY = { name, role }`, then `BoardSettings.refresh(id)`.
  **So the viewer's `role` is already known client-side on every board.**
- **BUT the session is not server-verifiable.** After login the board persists **only the phone
  number** (`localStorage` `advisorBoardPhone` / `gmBoardPhone` / …) — **not the PIN, no token,
  no Supabase Auth session** (`db.auth.signOut()` is defensive only; nothing ever signs in).
  Every DB call is the anon key.
- **Net:** role is available for **UX** (we can show/hide by `role`), but nothing stops a user
  from opening another role's board URL, editing `localStorage`, or calling the DB directly with
  the anon key. **Client role = a hint, not a boundary.**

## 4. Enforcement TODAY
- `shop_settings` is **anon-full-access** → the anon key embedded in every page can read AND write
  every setting. UI hiding (canEditShopMoney) is **cosmetic**; the write path is open to anyone
  with the page source.
- **The service-role pattern exists** and is the right tool: `api/announcement.js`,
  `api/desk-appointment.js`, `api/recording-*.js` run as Vercel functions with
  `process.env.SUPABASE_SERVICE_ROLE_KEY`, validate a body with a pure exported `parse*` fn
  (locked by a `.test.js`), and write via PostgREST. Those tables are RLS anon-**read**-only so
  the anon key can't write them — writes must go through the endpoint.
- **The missing piece for owner-only:** **none of those endpoints verify WHO is calling.** They
  are protected by "anon can't write the table", not by "the caller is the owner." There is no
  auth token to check. **True owner-only enforcement needs a server-verifiable identity first.**

## 4.1 The Features switchboard — first owner-only, role-gated category (BUILT 2026-08-07)
A new **"Features"** category in the shared modal holds **master on/off switches** for optional
parts of the app. It is the first category gated on **who you are**, not which board you opened —
a small, forward-compatible step toward the role-gated hub in PART B.
- **Registry-driven & extensible:** `shared/board-settings.js` defines a `FEATURE_FLAGS` array —
  each entry maps a stable `key` to its **boolean column on `shop_settings`** + the toggle's
  label/description. `renderFeaturesPane()` renders one iOS-style toggle per entry from
  `getShopSettings()`; `saveFeatureFlag(column, enabled)` writes the column on the single
  `shop_settings` row (same anon write path as every setting). Adding a future switch (e.g. the
  Phase 3 manager-approval toggle) is **one registry line + one additive boolean column** — no
  schema redesign. **Four entries today:** `book_hours` → `feature_book_hours` (see
  [[flat-rate-hours]] §9), `packages` → `feature_packages` (see [[packages]] / §4.2),
  `advisor_commission` → `feature_advisor_commission` (see [[advisor-commission]] / §4.3), and
  `bk_ro_detail` → `feature_bk_ro_detail` (the Bookkeeping per-RO parts/profit drill-down; see
  [[financial-pulse]] §9).
- **Owner-only gate:** the category's `visible` is `viewerRole === 'owner'`. `viewerRole` is a
  new module variable set by **`BoardSettings.refresh(employeeId, role)`** — each board now passes
  `who.role` from `captureSessionAndGreet()` (owner/gm/advisor/bookkeeping boards all updated). If
  the modal is open when the role resolves, it repaints so the category appears/disappears. A
  manager/advisor never sees Features even on a board with `canEditShopMoney` (gm-board).
- **Same caveat as §4:** this is a **UI-level gate only** — `shop_settings` is still
  anon-writable, so the switch is not server-enforced. It matches the current posture of every
  setting; real enforcement waits on the identity work in §6. The flag is **default OFF** and the
  reader **fails safe to OFF** (missing column / failed read → false), so the app degrades to
  pre-feature behavior, never to an accidental ON.

## 4.2 The "Rebuild Units & Prices" category — money-gated AND feature-gated (BUILT 2026-08-07)
A **Rebuild Units & Prices** pane (`renderPackagesPane`; category id `packages`) manages the
`package_units` list (Group / Unit / Set Price / Default R&R Hours; add / edit / delete). Unlike
Features (owner-only), it uses the **existing money gate**:
`visible = canEditShopMoney && getShopSettings().feature_packages`. So it shows for **owner/GM** (the
money-editing boards) **only when the Packages switch is on**, and is hidden for advisor and while
the feature is off. It's the first category whose visibility combines the money gate with a feature
flag. The list is **grouped by `group_label`** with a per-group "set price for whole group" bulk
shortcut (`setGroupPrice`). The RO builder reads the list via `BoardSettings.getPackageUnits()`.
Full wiring (the Package RO line type, price-vs-pay separation, print fold-in) lives in [[packages]].

## 4.3 The "Advisor Commission" category — owner-only AND feature-gated (BUILT 2026-08-08)
An **Advisor Commission** pane (`renderCommissionPane`; category id `commission`) sets the
per-advisor pay plan behind the commission widgets. Because it sets **pay**, its `visible` is
`viewerRole === 'owner' && getShopSettings().feature_advisor_commission` — owner-only, and only
when the Advisor Commission switch is on (advisor/GM/bookkeeping never see it). Two sections:
- **Per-advisor base + %** — one row per active `role='advisor'` employee: `commission_base_weekly`
  ($/full week) and `commission_gp_pct` (% of that week's GP). Blank → the engine's code default
  ($1,000 / 2.5%). Written to `employees` (`saveAdvisorPay`).
- **Assumed-margin fallbacks** — `shop_settings.parts_margin_pct` / `package_margin_pct` (stored
  as fractions; shown as %), used by the engine only when a parts/package line has no real cost;
  a real cost always overrides (`saveCommissionMargins`). Defaults 40% / 55%.
Same anon write path + UI-level gate as every setting (§4). Full feature (the GP engine + the
two cards) is documented in [[advisor-commission]].

---

# PART B — PROPOSED architecture (NOT built — approve first)

## 5. Role model
Reuse `employees.role` (values in use: `owner`, `manager`, `advisor`, `bookkeeping`, `tech`).
Two tiers for settings:
- **Owner** (Cristian) → every tab.
- **Manager** (Kevin) → **My Profile, Shop Profile, RO & Pricing, Rebuild Units & Prices,
  Payments** only.
- Owner-only tabs (**Team & Access, Pay & Flat-Rate, Boards & Announcements, Integrations**) are
  **hidden AND server-enforced**. Granting access is **owner-only**.

## 6. IDENTITY FIRST — the prerequisite (see §3)
Owner-only cannot be real until the server can verify the caller is the owner. Smallest real
mechanism, in preference order:
- **(Recommended) A tiny login endpoint that issues a signed session token.** `api/session.js`
  (service-role): POST `{ phone, pin }` → verify against `employees` → return a **short signed
  token** (HMAC with a server secret, or a Supabase Auth session if we adopt GoTrue later)
  carrying `{ employee_id, role, exp }`. Boards store the token (replacing the bare-phone
  session). Every settings **write** endpoint requires it and re-checks `role`. This is the one
  new primitive the whole hub leans on.
- **(Weaker stopgap) phone-in-body re-check.** Endpoint reads `employees.role` by the posted
  phone. Rejected as the final answer: phone isn't secret, so it's spoofable — acceptable only as
  a first commit if paired with a fast follow to real tokens. **Call this out to Cris; don't ship
  it as "secure."**
- Client-side role gating (`getCategories()` visibility keyed on the viewer's `role`) ships
  alongside for UX, but is **never** the security boundary.

## 7. Storage-backed, role-gated hub (extends today's modal)
- **Keep `shop_settings`** as the home for scalar shop/money/ops values (RO & Pricing, Shop
  Profile). New scalar settings just add a column + a field — nothing hardcoded.
- **New tables** (all `additive`, anon-**read**, service-role-write once §6 lands):
  - **`rebuild_units`** — the NEW "Rebuild Units & Prices" list: `id`, `name`/`unit_code`
    (e.g. transmission code), `pricing_group`, **one `base_price`** (the cash/base price; card
    payments add the existing 4% `card_fee_pct` **on the RO**, never a second stored price),
    `active`, timestamps. Becomes the source for the future rebuild-unit dropdown on the RO.
    *(Note: this is the customer-PRICE list. It is distinct from the pay-side rebuild book-hours
    work in [[flat-rate-hours]] §8 — hours feed tech pay, price feeds the invoice. Keep them
    separate tables so price and pay never fight; a unit may map to both.)*
  - **`role_access`** (or a `settings_access` grants table) — backs **Team & Access**; owner-only
    read/write. Lets the owner grant a manager extra tabs later without a code change.
  - **`integrations`** — backs the **Integrations** tab (provider config; secrets stay
    server-side / env, never in an anon-readable row).
  - **Pay & Flat-Rate** fields (R&R flat rate, guaranteed hours, rebuilder $/unit commission)
    live on `shop_settings` or a small `pay_settings` row — **stub the tab now**, fields
    disabled.
- **Category groups** in `getCategories()`: add a `group` field and render grouped nav
  (Personal / Shop / Pay & Team / Boards / Billing & Advanced), and change each category's
  `visible` from `canEditShopMoney` to a **role check** (`viewerRole === 'owner' ||
  (allowedForManager.has(id))`). This is a small, local change to the existing array + `renderPanes`.

## 8. Server-side enforcement
- Route **every settings write** for owner-only areas through a service-role endpoint
  (`api/settings.js`) mirroring `api/announcement.js`: pure exported `parseSettingsBody`
  (test-locked), service-role write, **plus a role check on the §6 token** (reject if not owner
  for owner-only keys). Flip the owner-only tables' RLS to anon-**read**-only so the anon key
  can't write them directly.
- RO & Pricing / Shop Profile / Rebuild Units may stay manager-writable; those can either keep
  anon-write short-term or move behind the same endpoint with a manager-or-owner check (cleaner).

## 9. Phased build order
1. **Identity (prerequisite, §6):** `api/session.js` + token; boards store/verify it. Nothing
   user-visible changes yet. *Without this, everything below is UI-only.*
2. **Hub shell + role-gated visibility (§7):** add `group` + role-based `visible` to
   `getCategories()`, grouped nav, and the viewer's `role` passed into `BoardSettings.init`
   (replace the hardcoded `canEditShopMoney`). Migrate the existing panes (My Profile, Shop
   Profile, RO & Pricing, Payments) in unchanged.
3. **New tab — Rebuild Units & Prices:** `rebuild_units` table + editor (base price per pricing
   group). Manager-visible.
4. **Server-enforce (§8):** `api/settings.js`, tighten RLS on owner-only tables, move owner-only
   writes behind it.
5. **Owner-only tabs:** Team & Access (`role_access` grants) → Boards & Announcements → Integrations.
6. **Pay & Flat-Rate:** stub the tab now (disabled fields); wire when the flat-rate model lands
   (ties into [[flat-rate-hours]]).

## 10. Risks & open questions
- **Anon key is public** (in every page's source): until owner-only writes move server-side,
  role gating is cosmetic. #1 risk.
- **Bare-phone session (no secret persisted):** a proper token means a real (small) auth change;
  the phone-only re-check is spoofable — don't call it "secure."
- **RLS flip is a breaking change:** switching a table from anon-write to anon-read-only breaks
  any current direct writer the moment it's applied — migrate the writer to the endpoint in the
  same change (same lesson as the announcement/desk endpoints).
- **Price vs pay confusion:** "Rebuild Units & Prices" (customer price) must stay distinct from
  rebuild **book hours** (tech pay, [[flat-rate-hours]] §8). One unit can feed both, but they are
  two columns/tables with different consumers.
- **`card_fee_pct` is a % on the RO, not a second price** — the rebuild list stores ONE base
  (cash) price; the card fee is applied at billing. Don't duplicate prices per payment type.
- **Bookkeeping board** also mounts BoardSettings (its own extra category) — the role-gate change
  must not regress it.

## Known gaps & open questions (as of 2026-07-30)
- No server-verifiable identity today (§3, §6) — the blocker for real owner-only settings.
- `card_fee_pct` schema default is 3% but the shop runs 4% (set in-app) — live value ≠ migration
  seed; verify against the live row before any report/quote uses it.
- Exact `rebuild_units` shape (pricing_group semantics, unit↔book-hours mapping) needs Cris's
  price list to finalize.

## Where it lives in the code
- Settings modal: `shared/board-settings.js` (`getCategories`, `renderPanes`, `renderRoPricingPane`,
  `saveShopSettings`, `getShopSettings`/`loadShopSettings`).
- **Features switchboard (§4.1):** `shared/board-settings.js` — `FEATURE_FLAGS` registry
  (`book_hours`, `packages`), `renderFeaturesPane`, `saveFeatureFlag`; category
  `visible: viewerRole === 'owner'`; `viewerRole` set via `refresh(employeeId, role)`.
- **"Rebuild Units & Prices" category (§4.2):** `shared/board-settings.js` — `renderPackagesPane`
  (grouped) + `setGroupPrice`, `addPackageUnit`/`savePackageUnit`/`deletePackageUnit`,
  `loadPackageUnits`/`getPackageUnits`; `package_units` (`migrations/20260807_packages.sql`). See
  [[packages]].
- Board wiring: `BoardSettings.init(...)` in `owner-board.html`, `gm-board.html`,
  `advisor-board.html`, `bookkeeping-board.html`; `BoardSettings.refresh(emp.id, role)` after
  `captureSessionAndGreet()` (now passes the viewer role).
- Storage: `migrations/20260716_shop_settings.sql` (+ `20260716_phase3_print_fields.sql` for the
  profile columns; `20260807_feature_book_hours_flag.sql` for the `feature_book_hours` switch);
  `employees` for My Profile.
- Identity: `crisdata.html` (PIN login + role routing); `captureSessionAndGreet()` on each board.
- Enforcement pattern to mirror: `api/announcement.js`, `api/desk-appointment.js`
  (service-role + test-locked `parse*`).
- Related docs: [[flat-rate-hours]] (rebuild book hours — the pay side), [[tech-board]] /
  [[my-numbers]] (no viewer role today), [[announcements]] (a live service-role write path).

## Session change log
- 2026-08-08 — **Added the fourth feature flag (`bk_ro_detail`)** — `shop_settings.feature_bk_ro_detail`
  (`migrations/20260808_bk_ro_detail_flag.sql`, additive boolean, **unapplied**), 4th `FEATURE_FLAGS`
  entry (owner Features pane, default OFF). Gates the Bookkeeping board's per-RO parts/profit
  drill-down (read-only; see [[financial-pulse]] §9). No RLS change; SHOP_DEFAULTS + getShopSettings
  extended. `shared/board-settings.js` + docs.
- 2026-08-08 — **Added the third feature flag (`advisor_commission`) + the owner-only,
  feature-gated "Advisor Commission" category (§4.3).** New
  `shop_settings.feature_advisor_commission` + `parts_margin_pct` / `package_margin_pct`
  and `employees.commission_base_weekly` / `commission_gp_pct`
  (`migrations/20260808_advisor_commission.sql`, additive, **not yet applied**).
  `renderCommissionPane` (`viewerRole==='owner' && feature_advisor_commission`) sets per-advisor
  base/% + the assumed-margin fallbacks. Full feature in [[advisor-commission]] (Hours Engine
  Part 2). UI-level gate, same posture as §4.
- 2026-07-30 — Created during the "CrisData Settings hub" investigation. Mapped today's storage
  (`shop_settings` fixed row + `employees`, all anon), the shared `board-settings.js` modal and
  its per-board hardcoded `canEditShopMoney` gate, and the identity model (real PIN login +
  role-routing via `crisdata.html`, but a bare-phone session and no server-verifiable identity /
  no role-checking endpoints). Proposed the role-gated, DB-backed hub with **identity-first** as
  the prerequisite, new `rebuild_units` / `role_access` / `integrations` tables, a service-role
  `api/settings.js`, and a 6-phase build order. **Investigation only — no app code changed.**
- 2026-08-07 — **Built the owner Features switchboard (§4.1)** — the first role-gated, owner-only
  category. Added a `FEATURE_FLAGS` registry + `renderFeaturesPane`/`saveFeatureFlag` over boolean
  columns on `shop_settings`, a `viewerRole` module var set via `refresh(employeeId, role)` (all
  four boards now pass `who.role`), and the category gated on `viewerRole==='owner'`. First flag:
  `feature_book_hours` (default OFF) — the Book Hours master switch (see [[flat-rate-hours]] §9).
  Storage is additive (`20260807_feature_book_hours_flag.sql`, reuses the anon `shop_settings`
  row — no new table/RLS). Gate is **UI-level only** (still anon-writable), same posture as §4;
  migration written, not yet applied. Verified in-browser (owner sees Features, manager doesn't;
  toggle default OFF; save fails safe pre-migration).
- 2026-08-07 — **Added the second feature flag (`packages`) + the money+feature-gated Packages
  category (§4.2).** New `shop_settings.feature_packages` (default OFF) and a `package_units`
  settings list (`migrations/20260807_packages.sql`, anon RLS + realtime like `payment_methods`).
  `renderPackagesPane` (add/edit/delete Unit / Set Price / Default R&R Hours) shows only when
  `canEditShopMoney && feature_packages`. RO reads units via `BoardSettings.getPackageUnits()`. Full
  feature (the Package RO line type) documented in [[packages]]. Verified in-browser: both Features
  toggles present, Packages category hidden while OFF, getPackageUnits fail-safe. Migration not yet
  applied.
- 2026-08-07 — Renamed the pane to **"Rebuild Units & Prices"**, added
  `package_units.group_label` (same migration, additive), a **grouped list** with a per-group "set
  price for whole group" bulk shortcut (`setGroupPrice`), and a per-row Group field. Storage line +
  §4.2 updated. Verified in-browser: grouping/order logic + toggle copy. Migration still not applied.
