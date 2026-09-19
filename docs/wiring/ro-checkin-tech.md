# How RO check-in, active-RO status & tech assignment are wired

> Doc: `/docs/wiring/ro-checkin-tech.md`
> Last updated: 2026-09-19 — **§7 added: Job category on the RO** (`repair_orders.job_category`,
> `shared/job-category.js`), **verified vs commit `a90963f`** on `test.*` as ZZ Test Advisor (see
> change log). **Shipped to prod at `de37577`** (2026-09-19); migration applied to sandbox AND prod
> (Cris, by hand). Rest not re-verified this session.
> Earlier: 2026-09-18 — §3/§4 gained "what the RO detail re-reads afterwards" (Warranty + Status
> refresh after check-in / tech assign, see [[comeback-warranty]] §6).
> Previously: 2026-07-30 — verified vs commit `596006c`
> Status: ✅ verified vs commit `596006c` — code re-checked against `advisor-board.html` +
> `crisdata-techboard.html`, and the floor-table columns introspected against the live DB.
> §4 assign-tech bug **FIXED**; §5 arrival-date **DONE**; §6 Work Description **DONE**.

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
- `checkInArrived(ro)` (`advisor-board.html:4986`): **PHYSICAL only — never touches the RO
  stage.** Idempotent. If no `shopboard_parking` row exists for the `po`, it inserts one
  (`status:'empty'` = "- Unassigned -", `po`/`customer`/`vehicle` pre-filled), then stamps
  `repair_orders.arrived_at = now`. Insert-first, then stamp, so a failed drop stays
  re-clickable.
- The **"Check in / Arrived" button** (`paintArrivedBtn`): green + active when `arrived_at`
  is null; after check-in it settles to a disabled **"Checked in ✓ · &lt;time&gt;"**.
- **After a successful check-in from the RO detail**, its `onDone` callback mirrors
  `arrived_at` onto the cached list row **and calls `refreshFloorControls()`**, so the
  Warranty / Comeback toggle and the work-Status dropdown come alive in place (they need the
  floor row that check-in just created). Before 2026-09-18 they stayed disabled until the RO was
  reopened — see [[comeback-warranty]] §6.
- **Arrival date defaults to today, with an optional back-date** — `checkInArrived(ro, opts)`
  takes `opts.arrivalDate` from the picker; today → the true now-stamp, a past date → that day
  (see §5). The default one-tap path is unchanged.

## 4. Tech assignment (`assignTechCore`) — and the bug
`assignTechCore(opts)` (`advisor-board.html:6184`; **mirrored verbatim in
`crisdata-techboard.html:308`**) is the single source of truth for assigning/clearing a car's
tech. It:
1. updates `repair_orders.technician` (degrades quietly if that column is missing);
2. **finds the car's floor row** via the pickup-aware `findStatusFloorRow` / `StatusMirror`
   (§2) — *not* the old uniform `select('id,status')` across all three tables (that was the bug);
3. if found → updates that row (`assigned_tech`, and nudges a pre-work row to
   `status:'waiting-tech'` — but only when it isn't the pickup zone);
4. if **not** on the floor and a tech is being assigned → **auto-check-in**: inserts a
   `shopboard_parking` row (`status:'waiting-tech'`, `arrival_date: today`).

On the RO detail, `onTechAssignChange` calls **`refreshFloorControls()`** after a successful
assign (not on failure), because steps 3–4 can create the floor row or move it to
`waiting-tech` — the Warranty toggle and Status dropdown re-read it in place
([[comeback-warranty]] §6). The Tech Board's copy has no such controls.

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

## 6. Work Description — advisor → tech instruction (Kevin)
An **internal** instruction from the advisor/manager to the mechanic (e.g. "remove the valve
body and take it to the bench"), stored in **`repair_orders.work_description`** (text, nullable;
`migrations/20260730_ro_work_description.sql`).
- **Distinct from two neighbors — do not merge:** `complaint` (the customer's concern) and
  `advisory_notes` (customer-facing recommendations that **print** on the invoice). Work
  Description is internal and **never prints**. It's also *not* the floor row's short `work`
  field — the tech modal shows both, labelled separately.
- **Edited** on the advisor-board RO detail — a textarea (`#cdRoWorkDescription`) placed
  **directly under Complaint** in the "Complaint & Notes" card; saved via `updateRoField`
  (a direct anon UPDATE; the RO select is `*` and `updateRoField` swallows a 42703, so it
  degrades quietly pre-migration).
- **Shown to the tech** read-only on the Tech Board (`crisdata-techboard.html`, the iframe
  behind advisor-board's "Tech Board" tab). The read-only job modal (`openJob`) renders floor
  data synchronously, then **`loadWorkDescriptionInto(po)`** fetches
  `repair_orders.work_description` **by `po`** and, if non-empty, inserts an emphasized
  `.m-field-work` block above the "Read-only view" footer (guards against a stale async and a
  missing column). The tech does **not** edit it — techs update jobs from My Numbers, and this
  modal is read-only by design.

## 7. Job category — the RO's own field (Kevin, Aug 10: "NOWHERE TO MARK JOB CATEGORY")
**What it is.** `repair_orders.job_category` (text, nullable) — **NULL = not decided yet**, or
exactly one of the two values in **`shared/job-category.js`** (`JOB_CATEGORIES`):
`Transmission rebuild` · `General repair`. The stored value *is* the label. A database CHECK
(`repair_orders_job_category_check`) allows only NULL or those two strings;
`shared/job-category.test.js` reads both migration files and fails if their CHECK and the JS list
ever disagree. `advisor-board.html` carries **no inline copy** of the two strings (also
test-locked), so the list lives in one place.
Migrations: `migrations/20260919_ro_job_category_{SANDBOX,PROD}.sql` (hand-run, sandbox first;
`app_env`-guarded; undo at the bottom). No backfill — every existing RO starts NULL.

**It lives on the RO ONLY.** It is **not** the floor rows' `shopboard_*.job_category` (the old
`Gen Auto / Rebuild / Diag` tag the discontinued Manager-board Shop Floor tab writes, [[tech-board]]
§4). Nothing copies between the two, in either direction, by decision (Cris, 2026-09-19). A static
test asserts no advisor-board floor insert/update carries a category.

**Where it's set.** The advisor-board RO detail, right column, **directly under Status**:
`#cdRoJobCategory` inside `#cdRoJobCategoryField`, with a NEW badge until `2026-09-28`
([[new-badge]]). Options (`buildJobCategoryOptions`): **"Pick a category"** (value `''`) then the
two values; the current value is selected. Changeable **at any stage** — estimate, active RO,
invoice. Advisor board only; the New-RO wizard does not ask (out of scope for this slice).
- **Render** — `renderJobCategory()`, called (not awaited) from `populateRoEditFields` on every RO
  open. It waits for the shared list via `jcReady()` (a `?ro=` deep link can open an RO before
  the deferred module has run; resolves null if the module never loads). Pre-migration the column
  is absent from the `select('*')` row → the dropdown stays disabled with *"Job category needs the
  database update"*; module failed → *"couldn't load — reload the page"*.
- **Blank = red, not blocked.** While blank the select carries `.cd-jc-unset` — the board's
  `var(--red)` border (same as `.cd-lf-bad`) + a 1px red ring + red text. It clears the moment a
  value is picked. **Nothing blocks on it**: no save gate, no stage gate, no close gate.
- **Save** — `setJobCategory(value)` on `change`: `jobCategoryForSave` maps "Pick a category" →
  `NULL`, writes `repair_orders.job_category` with `.select('id, job_category')` (an RLS-dropped
  0-row write is an error), reverts the select + alerts on failure. Choosing "Pick a category"
  again clears it back to NULL.

**At close — the archive copy.** `archiveToCompletedJobs` puts
`job_category: JobCategory.archiveJobCategory(ro)` in the `completed_jobs` payload — the RO's
**final** value, blank → NULL. `ro` is `currentRo`, the `repair_orders` row, **never** the floor
row. That matters for **Off lot** (`offLotCard`): it removes the car from the floor *first*, then
`loadRoContext` re-reads `repair_orders` `'*'` and closes — so the category is still on the RO it
reads. Same upsert-by-`(po, source_table='repair_orders')` as the rest of the payload: a re-close
overwrites the archive row with the then-current category. The quick diag-fee receipt
(`recordDiagReceipt`, `source_table='diag_receipt'`) does **not** carry a category.

**Who reads it downstream.** Only `completed_jobs.job_category` → the Bookkeeping **Financial
Pulse** income donut ([[financial-pulse]] §5), through `reportCategory()` in the same shared file:
old `Rebuild` → Transmission rebuild, old `Gen Auto` → General repair (`LEGACY_CATEGORY_NAMES`),
old `Diag` keeps its own slice, blank/unknown → Other. Every other `job_category` reader (Manager
board Technicians pills, Comebacks table, Tech Status pools, the Tech Board modal, My Numbers, the
advisor Approval Queue) reads the **floor rows**, which never receive the RO's value.

## Known gaps & open questions (as of 2026-07-30; §7 items as of 2026-09-19)
- **A category changed AFTER close** updates the RO but not its `completed_jobs` row (closed ROs
  aren't locked; only a re-close re-copies). Rare; not handled.
- The Tech Board modal makes **one extra `repair_orders` read by `po`** per open (for the work
  description). Cheap; only on modal open. A future option is to mirror it onto the floor row
  (like `technician` → `assigned_tech`) to avoid the read, but that adds a write path.
- Back-dating updates `repair_orders.arrived_at` (the display source) but does **not** rewrite
  the `arrival_date` of a floor row that *already existed* (a manual "+ Add Car"); the common
  path — check-in inserts the row with the chosen date — is unaffected.
- `arrived_at` is a history stamp, not a live on-floor flag — a car cleared off the floor still
  reads "Checked in ✓". Intentional, but easy to misread.
- The `shopboard_*` tables' real schema (e.g. `assigned_tech`, `tech_status`, `warranty`,
  `pickup` lacking `status`) lives only in the DB / `setup_shopboard.sql` (which is itself
  behind the live schema) — no maintained migration documents today's columns.

## Where it lives in the code
- Job category (§7): `shared/job-category.js` (`JOB_CATEGORIES`, `buildJobCategoryOptions`,
  `jobCategoryForSave`, `archiveJobCategory`, and for reports `LEGACY_CATEGORY_NAMES` /
  `REPORT_CATEGORY_ORDER` / `reportCategory`) + `shared/job-category.test.js` (19 tests: list,
  migration CHECK = list, close copy, old→new report map, advisor + bookkeeping static guards); `advisor-board.html` — the ESM loader
  (~1264), `.cd-jc-unset` (~432), `#cdRoJobCategoryField` (~2330), `jcReady` / `renderJobCategory`
  / `setJobCategory` (~6627–6690), the call in `populateRoEditFields` (~5938), the `change`
  listener (~7563), the `job_category:` line in `archiveToCompletedJobs` (~7378). Schema:
  `migrations/20260919_ro_job_category_{SANDBOX,PROD}.sql`.
- Work Description: `advisor-board.html` — `#cdRoWorkDescription` textarea (under Complaint) +
  its hydrate/`updateRoField('work_description', …)` wiring; `crisdata-techboard.html` —
  `loadWorkDescriptionInto` (in `openJob`) + the `.m-field-work` modal style. Schema:
  `migrations/20260730_ro_work_description.sql`.
- Check-in: `advisor-board.html` — `checkInArrived` (~4986), `paintArrivedBtn` (~5036); the RO
  detail's `onDone` (~6423) → `refreshFloorControls` (~5988).
- Tech assign: `advisor-board.html` — `assignTechCore` (~6184), `isPreWorkStatus` (~6169),
  RO-detail handler `onTechAssignChange` (~7469);
  **mirrored in** `crisdata-techboard.html` — `assignTechCore` (now with a local
  `findStatusFloorRow` wrapper + the `StatusMirror` ESM include).
- Pickup-aware floor resolver (the fix's linchpin): `shared/status-mirror.js`
  `findStatusFloorRow` (+ the `advisor-board.html:6270` wrapper), tested in
  `shared/status-mirror.test.js` (incl. the RO #6018 regression).
- Floor schema (partial / stale vs live): `setup_shopboard.sql`. Live columns verified by
  introspection, not a migration.

## Session change log
- 2026-09-19 — **Shipped:** prod = `de37577` after Cris ran the PROD migration (`set_count = 0`).
  Served `advisor-board.html` / `shared/job-category.js` byte-identical to git; prod
  `repair_orders.job_category` readable (all NULL). No prod RO opened.
- 2026-09-19 — **§7 Job category** (Kevin, Aug 10): `repair_orders.job_category` (NULL or one of
  the two values in `shared/job-category.js`), a dropdown under Status on the RO detail (red while
  blank, blocks nothing), copied into `completed_jobs.job_category` at close from the RO row. RO
  only — never mirrored to the floor. Financial Pulse naming gap logged — and fixed later the
  same day (old names mapped onto the new two in the Pulse, [[financial-pulse]] §5; verified on
  `test.*` at `7173ac6` — old and new rows share one slice).
  **Verified on `test.*` at `a90963f`, ZZ Test Advisor, sandbox migration applied:** blank RO →
  red "Pick a category" under Status (`rgb(239,68,68)` border + ring), NEW badge on; pick saved and
  survived a `?ro=` reload; Transmission rebuild → General repair saved; "Pick a category" again →
  NULL, red again. Closes: #6034 via Stage → `completed_jobs.job_category` = General repair;
  #5413 via **Off lot** → Transmission rebuild (its pickup row said `Gen Auto` and was deleted
  first — archive took the RO value); #6035 blank → not blocked, archive NULL. Floor rows never
  written. 375px: no horizontal scroll, select full-width, layout identical badge on/off. Console:
  only the pre-existing sandbox avatar-sign 400s.
- 2026-09-18 — RO detail now re-reads Warranty + Status after its own check-in and after a
  successful tech assign (`refreshFloorControls`, [[comeback-warranty]] §6). Line refs re-pointed.
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
- 2026-07-30 — Added **Work Description** (§6): an internal advisor→tech instruction on
  `repair_orders.work_description` (`20260730_ro_work_description.sql`), edited under Complaint
  on the advisor RO detail and shown read-only (by `po`) in the Tech Board job modal. Kept
  distinct from `complaint` / `advisory_notes`. Verified in the browser (advisor field placement
  + tech modal block; graceful pre-migration).
