# How RO check-in, active-RO status & tech assignment are wired

> Doc: `/docs/wiring/ro-checkin-tech.md`
> Last updated: 2026-07-30 — verified vs commit `832077d`
> Status: ✅ verified vs commit `832077d` — code re-checked against `advisor-board.html` +
> `crisdata-techboard.html`, and the floor-table columns introspected against the live DB.
> Documents a **known bug** (§4) that is not yet fixed.

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
- **Arrival date is hard-coded to today** — `arrival_date: now.slice(0,10)` and
  `arrived_at: now`. There is **no UI to enter the car's actual arrival day** (see §5).

## 4. Tech assignment (`assignTechCore`) — and the bug
`assignTechCore(opts)` (`advisor-board.html:4469`; **mirrored verbatim in
`crisdata-techboard.html:276`**) is the single source of truth for assigning/clearing a car's
tech. It:
1. updates `repair_orders.technician` (degrades quietly if that column is missing);
2. **finds the car's floor row** by looping `['shopboard_parking','shopboard_lifts',
   'shopboard_pickup']` and doing `db.from(t).select('id,status')`;
3. if found → updates that row (`assigned_tech`, and nudges a pre-work row to
   `status:'waiting-tech'`);
4. if **not** on the floor and a tech is being assigned → **auto-check-in**: inserts a
   `shopboard_parking` row (`status:'waiting-tech'`, `arrival_date: today`).

**🐞 BUG (Kevin, RO #6018 → "Cory"):** step 2 selects `status` from **all three** tables,
including `shopboard_pickup`, which has **no `status` column**. When the car is **not** in
parking or lifts (an Active RO that isn't checked in — exactly #6018's state at assign time),
the loop reaches `shopboard_pickup`, the select returns Postgres **42703
`column shopboard_pickup.status does not exist`** (surfaced to Kevin as
`"column shopboard.pickup_status does not exist"` — an underscore/dot transcription of the
same error), and `assignTechCore` returns that error and aborts **before** the auto-check-in
insert can run. So the intended "assign a tech → auto-check-in" never happens, and the assign
looks blocked.
- Contributing edge case: even a car that *is* in `shopboard_pickup` would hit the same select
  before it could be found.
- Both `advisor-board.html` and `crisdata-techboard.html` carry the identical loop → the bug
  is on both boards.

**Fix options (not yet applied):**
- **A — reuse the correct helper (preferred):** resolve the floor row via
  `findStatusFloorRow` / `StatusMirror.findStatusFloorRow` (already pickup-aware), and when the
  hit is pickup (`isPickup`/`status:null`) set **only `assigned_tech`** in the patch (skip
  `status`, which pickup lacks). One shared fix; also de-duplicates the ad-hoc loop.
- **B — targeted select fix:** in the loop, select `id` (not `status`) for `shopboard_pickup`,
  **and** guard the update/auto-check-in so `status` is only written to tables that have it.
  Smaller diff, but leaves two copies of the logic.
- Either way, **apply to both** `advisor-board.html` and `crisdata-techboard.html` (verbatim
  mirror), and add a regression check for "assign a tech to a not-checked-in Active RO."
- **On Kevin's gating point:** there is **no separate check-in gate** on tech assignment — the
  code already *intends* to auto-check-in on assign (step 4). Fixing the select bug delivers
  exactly what Kevin expects (Active RO → assign tech → car dropped onto the floor). No new
  "auto-check-in Active ROs" feature is needed; auto-check-in on *assign* is the right trigger
  (auto-checking-in every Active RO at creation would wrongly drop cars that haven't arrived).

## 5. The arrival-date question (Kevin)
Confirmed: the check-in / arrival date is **hard-coded to today** in two places —
`checkInArrived` (`arrival_date` + `arrived_at`) and `assignTechCore`'s auto-check-in
(`arrival_date`) — and the "+ Add Car" manual entry on v1 does the same. There is **no field
to type the actual arrival day**.
- **Recommended approach (not yet applied):** add an optional **arrival-date input** to the
  check-in control (default = today), thread it through `checkInArrived` into `arrival_date`
  (a `date`) — and decide whether a back-dated check-in should also move `arrived_at` (a
  `timestamptz`, currently the true stamp time that drives "Checked in ✓ · &lt;time&gt;"). Keep
  "today" as the default so the common case is unchanged.

## Known gaps & open questions (as of 2026-07-30)
- **The §4 bug is live** on both boards and unfixed.
- `arrived_at` is a history stamp, not a live on-floor flag — a car cleared off the floor still
  reads "Checked in ✓". Intentional, but easy to misread.
- The `shopboard_*` tables' real schema (e.g. `assigned_tech`, `tech_status`, `warranty`,
  `pickup` lacking `status`) lives only in the DB / `setup_shopboard.sql` (which is itself
  behind the live schema) — no maintained migration documents today's columns.

## Where it lives in the code
- Check-in: `advisor-board.html` — `checkInArrived` (~3646), `paintArrivedBtn` (~3681).
- Tech assign: `advisor-board.html` — `assignTechCore` (~4469), `isPreWorkStatus` (~4454);
  **mirrored in** `crisdata-techboard.html` — `assignTechCore` (~276).
- Correct pickup-aware floor resolver: `findStatusFloorRow` (`advisor-board.html:4554`) +
  `shared/status-mirror.js`.
- Floor schema (partial / stale vs live): `setup_shopboard.sql`. Live columns verified by
  introspection, not a migration.

## Session change log
- 2026-07-30 — Created during the RO #6018 "assign tech" investigation. Root-caused the
  `shopboard_pickup` has-no-`status` select bug in `assignTechCore` (both boards), confirmed
  the arrival date is hard-coded to today, and clarified that "Active RO" and "checked in" are
  independent axes with auto-check-in already intended on assign. **Investigation only — no app
  code changed.**
