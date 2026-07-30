# How RO check-in, active-RO status & tech assignment are wired

> Doc: `/docs/wiring/ro-checkin-tech.md`
> Last updated: 2026-07-30 — verified vs commit `PENDING`
> Status: ✅ verified vs commit `PENDING` — code re-checked against `advisor-board.html` +
> `crisdata-techboard.html`, and the floor-table columns introspected against the live DB.
> The §4 assign-tech bug is **FIXED**; the §5 arrival-date entry is now **DONE**.

## 0. In one line
An RO's **stage** (`repair_orders.status`, e.g. "ro" = Active) and its **physical presence**
(checked in → a row on the shop floor + `arrived_at`) are **two independent axes**; assigning
a tech mirrors onto the floor row and auto-checks-in a car that isn't on the floor yet.

## 1. The two axes — "Active RO" ≠ "checked in"
- **Stage:** `repair_orders.status` — `'ro'` is an **Active RO**. Set when the RO becomes a
  live repair order; it says nothing about whether the car is physically here.
- **Checked in:** the car has a **floor row** (one of the three `shopboard_*` tables) **and**
  `repair_orders.arrived_at` is stamped. `arrived_at` is **history, not a live on-floor flag**
  (it stays set even after the car is later picked up / cleared).
- So an RO can be **Active but not checked in** (created before the car arrives) — this is the
  state at the heart of the bug in §4.

## 2. The shop floor — three tables, and a schema quirk that matters
The v1 shop-board floor is three tables (all anon full-access, realtime):
`shopboard_parking`, `shopboard_lifts`, `shopboard_pickup`. A car is located by `po`.

**⚠ The quirk that causes the bug:** **`shopboard_pickup` has NO `status` column.**
`shopboard_parking` and `shopboard_lifts` have `status`; `shopboard_pickup` does not (it's the
"ready for pickup" zone — no work status; it carries `customer` / `undo_*` instead). Both
`shopboard_pickup` and the other two *do* have `assigned_tech`. (Verified against the live
schema 2026-07-30.) Any code that reads/writes `status` uniformly across all three tables
breaks on `shopboard_pickup`.

The **correct**, pickup-aware pattern already exists — `findStatusFloorRow`
(`advisor-board.html`, and the shared `shared/status-mirror.js`): it loops `parking` + `lifts`
selecting `id,status`, then queries `shopboard_pickup` **id-only** and returns
`{ isPickup:true, status:null }`.

## 3. Check-in (`checkInArrived`) — a physical event
- `checkInArrived(ro)` (`advisor-board.html:3646`): **PHYSICAL only — never touches the RO
  stage.** Idempotent. If no `shopboard_parking` row exists for the `po`, it inserts one
  (`status:'empty'` = "- Unassigned -", `po`/`customer`/`vehicle` pre-filled), then stamps
  `repair_orders.arrived_at = now`. Insert-first, then stamp, so a failed drop stays
  re-clickable.
- The **"Check in / Arrived" button** (`paintArrivedBtn`): green + active when `arrived_at`
  is null; after check-in it settles to a disabled **"Checked in ✓ · &lt;time&gt;"**.
- **Arrival date defaults to today, with an optional back-date** — `checkInArrived(ro, opts)`
  takes `opts.arrivalDate` from the picker; today → the true now-stamp, a past date → that day
  (see §5). The default one-tap path is unchanged.

## 4. Tech assignment (`assignTechCore`) — and the bug
`assignTechCore(opts)` (`advisor-board.html:4469`; **mirrored verbatim in
`crisdata-techboard.html:276`**) is the single source of truth for assigning/clearing a car's
tech. It:
1. updates `repair_orders.technician` (degrades quietly if that column is missing);
2. **finds the car's floor row** via the pickup-aware `findStatusFloorRow` / `StatusMirror`
   (§2) — *not* the old uniform `select('id,status')` across all three tables (that was the bug);
3. if found → updates that row (`assigned_tech`, and nudges a pre-work row to
   `status:'waiting-tech'` — but only when it isn't the pickup zone);
4. if **not** on the floor and a tech is being assigned → **auto-check-in**: inserts a
   `shopboard_parking` row (`status:'waiting-tech'`, `arrival_date: today`).

**🐞 BUG (Kevin, RO #6018 → "Cory") — ✅ FIXED (Option A):** step 2 *used to* select `status`
from **all three** tables, including `shopboard_pickup`, which has **no `status` column**. When
the car was **not** in parking or lifts (an Active RO that isn't checked in — exactly #6018's
state at assign time), the loop reached `shopboard_pickup`, the select returned Postgres
**42703 `column shopboard_pickup.status does not exist`** (surfaced to Kevin as
`"column shopboard.pickup_status does not exist"` — an underscore/dot transcription of the same
error), and `assignTechCore` returned that error and aborted **before** the auto-check-in
insert could run.

**The fix:** step 2 now resolves the floor row via the **pickup-aware helper**
`findStatusFloorRow` (which delegates to the shared, tested `StatusMirror.findStatusFloorRow`):
it selects `id,status` from parking + lifts, then queries `shopboard_pickup` **id-only** and
returns `{ isPickup:true, status:null }`. A not-on-floor car now resolves to `null` cleanly, so
`assignTechCore` proceeds to its **auto-check-in** insert as intended. The floor-row patch also
guards `!found.isPickup` before writing `status`, so assigning a tech to a car in the pickup
zone writes **only `assigned_tech`** (never the missing `status` column).
- Applied to **both** boards. `crisdata-techboard.html` had neither the helper nor
  `StatusMirror`, so this change added the `StatusMirror` ESM include + a `findStatusFloorRow`
  wrapper there, making its `assignTechCore` identical to advisor-board's.
- Regression test: `shared/status-mirror.test.js` — a schema-accurate mock where selecting
  `status` from `shopboard_pickup` 42703s; asserts the helper resolves a not-on-floor car to
  `null` **without** ever asking pickup for `status`. Verified live too: the old
  `select id,status` on `shopboard_pickup` still 42703s, while the helper returns `null` cleanly.

- **On Kevin's gating point:** there is **no separate check-in gate** on tech assignment — the
  code already *intends* to auto-check-in on assign (step 4). Fixing the select bug delivers
  exactly what Kevin expects (Active RO → assign tech → car dropped onto the floor). No new
  "auto-check-in Active ROs" feature is needed; auto-check-in on *assign* is the right trigger
  (auto-checking-in every Active RO at creation would wrongly drop cars that haven't arrived).

## 5. Arrival date — ✅ DONE (optional back-date)
The check-in control now has an optional **arrival-date input** (`#cdRoArrivedDate`) beside the
"Check in / Arrived" button:
- **Default = today, `max` = today** (no future arrivals). The one-tap-today path is unchanged:
  a missing/today value keeps the exact prior behavior (`arrival_date` = today, `arrived_at` =
  the true now-stamp).
- **A past date back-dates the check-in.** `checkInArrived(ro, { arrivalDate })` threads it into
  the floor row's `arrival_date` **and** sets `repair_orders.arrived_at` to **noon-local of that
  day** (date-safe), so the two never disagree and the **"Checked in ✓ · &lt;date&gt;"** display
  reflects the real arrival. A future value is clamped to today.
- The picker shows only while `arrived_at` is null; once checked in it's hidden and the button
  settles to "Checked in ✓ · &lt;date&gt;".
- **The auto-check-in path (`assignTechCore`, §4) stays on today** — it has no UI, by design.
  (`assignTechCore` inserts with `arrival_date: today`.)

## Known gaps & open questions (as of 2026-07-30)
- Back-dating updates `repair_orders.arrived_at` (the display source) but does **not** rewrite
  the `arrival_date` of a floor row that *already existed* (a manual "+ Add Car"); the common
  path — check-in inserts the row with the chosen date — is unaffected.
- `arrived_at` is a history stamp, not a live on-floor flag — a car cleared off the floor still
  reads "Checked in ✓". Intentional, but easy to misread.
- The `shopboard_*` tables' real schema (e.g. `assigned_tech`, `tech_status`, `warranty`,
  `pickup` lacking `status`) lives only in the DB / `setup_shopboard.sql` (which is itself
  behind the live schema) — no maintained migration documents today's columns.

## Where it lives in the code
- Check-in: `advisor-board.html` — `checkInArrived` (~3646), `paintArrivedBtn` (~3681).
- Tech assign: `advisor-board.html` — `assignTechCore` (~4469), `isPreWorkStatus` (~4454);
  **mirrored in** `crisdata-techboard.html` — `assignTechCore` (now with a local
  `findStatusFloorRow` wrapper + the `StatusMirror` ESM include).
- Pickup-aware floor resolver (the fix's linchpin): `shared/status-mirror.js`
  `findStatusFloorRow` (+ the `advisor-board.html:4554` wrapper), tested in
  `shared/status-mirror.test.js` (incl. the RO #6018 regression).
- Floor schema (partial / stale vs live): `setup_shopboard.sql`. Live columns verified by
  introspection, not a migration.

## Session change log
- 2026-07-30 — Created during the RO #6018 "assign tech" investigation. Root-caused the
  `shopboard_pickup` has-no-`status` select bug in `assignTechCore` (both boards), confirmed
  the arrival date is hard-coded to today, and clarified that "Active RO" and "checked in" are
  independent axes with auto-check-in already intended on assign.
- 2026-07-30 — **Fixed the §4 bug (Option A):** `assignTechCore` now resolves the floor row via
  `findStatusFloorRow` / `StatusMirror` (pickup-aware) and guards `!isPickup` before writing
  `status`; applied to both boards (added `StatusMirror` + a `findStatusFloorRow` wrapper to
  `crisdata-techboard.html`); added the RO #6018 regression to `shared/status-mirror.test.js`.
  Verified live (old path 42703s, helper resolves not-on-floor to null). Arrival-date entry (§5)
  intentionally left for a follow-up.
- 2026-07-30 — **Arrival date (§5) done:** added an optional arrival-date picker to the check-in
  control (default today, `max` today). `checkInArrived(ro, {arrivalDate})` threads it into
  `arrival_date` and, for a back-date, sets `arrived_at` to noon-local of that day so the display
  matches. Auto-check-in (`assignTechCore`) stays on today. Verified both button states in the
  browser + the date arithmetic (today/back-date/future-clamp).
