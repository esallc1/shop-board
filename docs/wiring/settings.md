# How Settings is wired (and the proposed role-gated hub)

> Doc: `/docs/wiring/settings.md`
> Last updated: 2026-07-30 — verified vs commit `0663cbd`
> Status: ✅ §0–§4 (today's wiring) verified vs `0663cbd` — read against
> `shared/board-settings.js`, `migrations/20260716_shop_settings.sql`, `crisdata.html`, the four
> board `BoardSettings.init` calls, and `api/announcement.js`. **§5–§10 are a PROPOSED
> architecture — NOT built, pending approval.** Investigation only; no feature code changed.

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
- Board wiring: `BoardSettings.init(...)` in `owner-board.html`, `gm-board.html`,
  `advisor-board.html`, `bookkeeping-board.html`; `BoardSettings.refresh(emp.id)` after
  `captureSessionAndGreet()`.
- Storage: `migrations/20260716_shop_settings.sql` (+ `20260716_phase3_print_fields.sql` for the
  profile columns); `employees` for My Profile.
- Identity: `crisdata.html` (PIN login + role routing); `captureSessionAndGreet()` on each board.
- Enforcement pattern to mirror: `api/announcement.js`, `api/desk-appointment.js`
  (service-role + test-locked `parse*`).
- Related docs: [[flat-rate-hours]] (rebuild book hours — the pay side), [[tech-board]] /
  [[my-numbers]] (no viewer role today), [[announcements]] (a live service-role write path).

## Session change log
- 2026-07-30 — Created during the "CrisData Settings hub" investigation. Mapped today's storage
  (`shop_settings` fixed row + `employees`, all anon), the shared `board-settings.js` modal and
  its per-board hardcoded `canEditShopMoney` gate, and the identity model (real PIN login +
  role-routing via `crisdata.html`, but a bare-phone session and no server-verifiable identity /
  no role-checking endpoints). Proposed the role-gated, DB-backed hub with **identity-first** as
  the prerequisite, new `rebuild_units` / `role_access` / `integrations` tables, a service-role
  `api/settings.js`, and a 6-phase build order. **Investigation only — no app code changed.**
