# How the flagged-hours / book-hours (tech-pay) data is wired

> Doc: `/docs/wiring/flat-rate-hours.md`
> Last updated: 2026-08-07 — verified vs commit `54f3683`
> Status: ✅ verified vs code AND live schema this session. **`book_hours` capture is
> BUILT** in `advisor-board.html` + `shared/board-settings.js`, and now sits behind an
> **owner-controlled master switch, defaulted OFF** (§9). Its migration
> `migrations/20260730_ro_book_hours.sql` **has been applied** — `repair_orders.book_hours`
> / `book_hours_na` confirmed live via the anon REST API. §1–§7 remain the original
> data-feasibility findings (the "why we needed a real hours number"). **The flat-rate /
> rebuild-lookup idea was dropped** — hours come from ALLDATA per vehicle, typed by hand;
> there is no hours-per-rebuild table. The now-unused `rebuild_book_hours` table and
> `repair_orders.rebuild_type` column (both confirmed empty live) are staged for a manual
> DROP. §8 documents the shipped capture; §9 documents the on/off switch.

## 0. In one line
A per-tech per-week **flagged book-hours** report needs three fields — **who**
(`assigned_tech`/`technician`), **how many book hours** (now `repair_orders.book_hours`),
and **when finished** (a completion `*_at`). The **hours** field is now captured at the
estimate: the advisor types the **ALLDATA book time** he looks up per vehicle into a
**Book Hours** field on the RO, gated so a job can't leave Estimate until it's a number
or an explicit N/A. **Tech attribution and a reliable completion timestamp are still the
open gaps** (§3, §4, §6) — so the number is captured, but a clean weekly *per-tech* report
still can't be built from these tables alone.

## 1. The two parallel worlds this data lives in
There are **two separate systems**, linked only by the shared text key **`po`** (a CrisData RO
mints `ro_number` from 6000 and `po` mirrors it):
- **CrisData RO / estimate world** — `repair_orders` + `ro_line_items` (Josh builds the estimate
  here with ALLDATA book time). This is where *quoted labor* and now **`book_hours`** live.
- **Shop-floor world** — `shopboard_lifts` / `shopboard_parking` / `shopboard_pickup`, the
  advisor **Approval Queue** (sets `flag_hours`), My Numbers (the tech's status buttons), and the
  **`completed_jobs`** archive. This is where *flagged hours*, *tech*, and *completion* are meant
  to be captured.
- ⚠ **ALLDATA still runs in parallel.** CrisData ROs start at 6000; ALLDATA is at ~5498 and is
  still the system of record for most jobs. Any historical report built only on these tables
  covers a small, recent slice — most real jobs never entered them.

## 2. Input #1 — book hours (the core number). **Now CAPTURED at the estimate.**
- **Source of truth: `repair_orders.book_hours` (numeric)** + `book_hours_na (boolean)`, written
  by the RO builder in `advisor-board.html` (see §8). The advisor types the **ALLDATA book time**
  for that vehicle. This is a **PAY** number — it never enters the customer price math.
- **Historically (pre-build) the number was effectively uncaptured:** the floor
  `shopboard_*.flag_hours` (typed by the advisor at Approval-Queue time) was populated on ~1 row
  shop-wide, and `flag_hours` was null on all `completed_jobs`. `book_hours` exists to fix that at
  the source (the estimate), then **mirrors down** to the floor `flag_hours` so the rest of the
  pipeline is unchanged (§8.3).
- **Quoted book hours from `ro_line_items` are a *different, unreliable* figure** and are NOT the
  hours number: labor rows have `quantity`=hours only when priced hourly, but the shop's
  big-ticket jobs are entered **flat** ("R&R TRANS W/OVERHAUL (6L80)" `qty 1 × $4950`), so
  `SUM(quantity)` silently under-counts every flat-priced overhaul as "1". This is exactly why the
  advisor types `book_hours` by hand instead of the report deriving it from line items.

## 3. Input #2 — the tech. **Present but free-text, sparse, and not historical.**
- **Sources (all free-text names, no FK):** `repair_orders.technician` (text; added Phase 3),
  and `shopboard_*.assigned_tech` → archived as `completed_jobs.assigned_tech`.
- **Identity mapping:** by **string match to `employees.name`** — this is how My Numbers scopes a
  tech's jobs. Names are currently distinct first names, so matching works, but a rename or a name
  collision would silently mis-attribute.
- **The only real employee FK on the RO is `service_writer_id`** (→ `employees.id`) — the
  **writer** (Josh), *not* the tech.
- **⚠ Sparse / inconsistent:** `technician` is null on most recent ROs; `assigned_tech` appears as
  a real name, **`"Unassigned"`, `""`, or `null`** — three "no tech" encodings to normalize.
- **⚠ Not historical / last-write-wins:** `assigned_tech`/`technician` hold only the *current*
  tech. A reassignment overwrites the prior tech with no history. A job worked by two techs (diag
  tech vs repair tech), or handed off, credits only the final name. **This is the biggest open gap
  for the flat-rate report** — `book_hours` is one number per RO, so it can't be split between the
  diag tech and the repair tech.
- **⚠ Lift bays may carry a *station* tech, not a job tech:** an empty lift row can still have
  `assigned_tech` set (the tech who owns the bay), so reading it isn't guaranteed to mean "did
  this job."

## 4. Input #3 — completion (the moment to credit a week). **No reliable timestamp.**
- **`repair_orders` has NO completion timestamp** — its `status` enum reaches `closed`
  (`estimate → ro → invoice → closed`) but there is **no `closed_at`/`invoiced_at`/`completed_at`**
  column. So "closed" carries no *when*.
- **The intended "work finished" stamp is `tech_finished_at`** (My Numbers "Mark Job Complete"),
  but it is null on every live floor row and every archived job — that path isn't how jobs move
  today (managers use the floor dropdown, which writes raw `status` only, never a `*_at` stamp).
- **The only populated completion signal is `completed_jobs.picked_up_at`** (archive event), but
  "picked up" is the customer collecting the car, which can lag actual work completion by days — so
  week-bucketing by it is approximate, and only exists for archived jobs.

## 5. What `book_hours` fixes and what it doesn't
| Report input | Before | Now |
|---|---|---|
| **Hours** | uncaptured (`flag_hours` on ~1 row; `SUM(quantity)` under-counts flats) | ✅ **captured** — `repair_orders.book_hours`, typed ALLDATA hours, gated, mirrored to floor `flag_hours`, archived on close |
| **Tech** | free-text, sparse, last-write-wins, sometimes a bay station | ❌ unchanged — still one free-text name per RO; diag vs repair tech not split |
| **Completion** | no RO timestamp; only `picked_up_at` (lags) | ❌ unchanged |

So the **hours** leg is solved at the source; **tech attribution** and a **completion timestamp**
are the remaining prerequisites for a trustworthy weekly per-tech report.

## 6. Gaps that still block a trustworthy weekly per-tech report
1. **Tech attribution is free-text, sparse, non-historical, and sometimes a bay station** (§3):
   nulls/`"Unassigned"`/`""`, no employee FK, last-write-wins on reassignment, and lift
   `assigned_tech` can mean "owns the bay."
2. **Multi-tech jobs can't be split** — one `assigned_tech`/`technician` slot and one `book_hours`
   number per job, so diag-tech vs repair-tech pay can't be separated yet (the explicit next design
   slice — see the WIP snapshot commit note).
3. **No per-RO completion timestamp; `tech_finished_at` unused** — only `picked_up_at` (archive) is
   populated, and it lags real completion, so week-bucketing is approximate.
4. **`completed_jobs` has duplicate rows** — some POs appear twice (old pickup archiver in
   `gm-board sfArchivePickup`, `source_table='shopboard_pickup'`; new RO-close archiver in
   `advisor-board`, `source_table='repair_orders'`). Each dedups only within its own `source_table`;
   `diag_receipt` can add a third. **Any `SUM` over `completed_jobs` must dedup by `po`.**
5. **Comebacks / warranty rework** — needs an explicit credit rule (credit again? exclude? charge
   back?) or the report double-pays or drops rework.
6. **ALLDATA parallel coverage** — most real jobs are still in ALLDATA and invisible to any report
   built on these tables; only jobs that become CrisData ROs get a `book_hours`.

## 7. What would still have to be true for the per-tech report
- A **real completion timestamp** on the RO (a `closed_at`, or reliably-set `tech_finished_at`).
- **Dedup `completed_jobs` by `po`** (or a single archive writer) before any aggregation.
- **Tech identity as an FK** (or a normalized, non-null, non-station name), and a way to **split a
  job's hours across the diag tech and the repair tech** (per-phase attribution — not built).
- A **comeback/warranty rule** for how rework hours count.

## 8. Book-hours capture — how it's wired now (BUILT; migration pending)
**Decision:** the advisor records **book hours on every RO/estimate**, typing the **ALLDATA book
time for that specific vehicle**. There is **no hours-per-rebuild lookup table** — an early
"flat-rate rebuild" design (a shop-set `rebuild_book_hours` table + a `rebuild_type` selector that
auto-filled hours) was **removed**, because at this shop hours come from ALLDATA per vehicle, not a
fixed number per transmission.

### 8.1 The one principle that makes it safe: book-hours is a PAY field, not a PRICE field
Customer **price** stays exactly as today — `Σ(quantity × unit_price)` over `ro_line_items`
(`recalcTotals`). **`book_hours` is a separate per-job number that never enters the money math.**
Price (line math) and pay (`book_hours`) are different columns with different consumers
(invoice/totals vs. tech-pay/report), so they cannot fight. A flat-priced job keeps its
`qty 1 × $flat` labor line (price unchanged) **and** carries, say, 12.0 book hours for pay.

### 8.2 The three-way state (why there are two columns)
A lone nullable numeric only expresses "null vs a number", but capture needs **three** states:
- `book_hours IS NULL` **and** `book_hours_na = false` → **NOT captured** (blank — blocks leaving
  Estimate);
- `book_hours = <n>` → **captured hours** (`n = 0` is a real, allowed value, distinct from blank);
- `book_hours IS NULL` **and** `book_hours_na = true` → **explicit N/A** (a diagnostic-only /
  no-labor RO — never trapped into a fake number).

Hence the extra `book_hours_na` boolean. The floor mirror writes `flag_hours` = the number when
captured, and NULL for both blank and N/A.

### 8.3 Where the number lives and flows
- **System of record:** `repair_orders.book_hours` / `book_hours_na`
  (`migrations/20260730_ro_book_hours.sql` — **applied**, confirmed live; additive, nullable; the
  app still carries `isMissingColumn` fallbacks so it degraded quietly in the pre-apply window).
- **Capture UI:** the **Book Hours** field on the RO detail (`#cdRoBookHoursField`,
  `advisor-board.html:1462`) — a number input `#cdRoBookHours` + an `#cdRoBookHoursNA` "N/A (no
  labor)" checkbox. Ticking N/A disables and clears the number; typing a number clears N/A.
  `populateBookHours()` hydrates it from the stored RO; `saveBookHours()` persists and mirrors;
  `paintBookHoursHint()` shows the "enter hours (or N/A) before leaving Estimate" / "N/A — no
  labor" hint.
- **Write-through mirror to the floor:** `mirrorBookHoursToFloor(po, hours)`
  (`advisor-board.html:4758`) copies the captured number onto the floor row's **existing**
  `flag_hours` column by `po` (number when captured; NULL for blank or N/A). It never creates a
  floor row, never writes the pickup zone, and degrades quietly off-floor / pre-migration — which
  is why **no new floor column is needed and the pickup archive keeps working unchanged**.
- **Archive on close:** the RO-close archiver (`advisor-board.html:5334`) writes
  `flag_hours: ro.book_hours` into `completed_jobs`, so closed CrisData ROs land the pay number in
  the archive.
- **Pickup archive:** `gm-board.html sfArchivePickup()` (~3354) already copies `flag_hours` from
  the floor row / `undo_car` snapshot — works unchanged because the mirror kept the floor
  `flag_hours` current.
- **Approval-Queue prefill:** `prefillFlagHoursFromBookHours()` (`advisor-board.html:2000`) reads
  each queued job's `book_hours` and pre-fills the queue card's Flag Hours input, so the advisor
  **confirms** the number instead of re-typing (blank / N/A stay blank).

### 8.4 The gate — book hours must be captured to leave Estimate
`bookHoursGateForAdvance(roId, po)` (`advisor-board.html:4772`) is the single choke point, **shared
by both ways a job can advance** so neither bypasses the other:
- the RO-detail **Stage select** (`~advisor-board.html:5237`), and
- the **kanban drag** (`~advisor-board.html:4053`).

Moving **out of Estimate** requires `book_hours` **captured** — a number OR explicit N/A; blank is
blocked with a message pointing at the Book Hours field. It fetches fresh, and returns `{ ok:true }`
pre-migration (missing column) so it never blocks before the columns exist. **It never touches the
customer price.**

### 8.5 What still makes the captured hours imperfect (carry-over from §6)
- **Divergent copies** — `book_hours` (RO, source of truth) vs `flag_hours` (floor / archive). Kept
  consistent by making the floor/archive copies **write-through mirrors**, never independently
  edited.
- **Blank silently defaulting to 0** — avoided by null-means-missing + the gate + the N/A escape
  hatch, so nothing slips through unseen.
- **Still unsolved by this slice:** multi-tech / per-phase split, reassignment history, the
  comeback/warranty credit rule, and ALLDATA-parallel jobs that never become CrisData ROs.

## 9. The master on/off switch (owner-controlled, default OFF)
The entire Book Hours feature sits behind **one owner switch**, so the shop can adopt it when
ready and, until then, the advisor board looks and behaves exactly as it did before the feature.

- **Where the flag lives:** `shop_settings.feature_book_hours boolean not null default false`
  (migration `20260807_feature_book_hours_flag.sql`). It rides the existing single-row
  `shop_settings` table — same anon-full-access RLS, no new table, no RLS change (see
  [[settings]] §1). One boolean per feature; adding a future switch is one more column.
- **Who can flip it:** an **owner-only "Features" pane** in the shared Settings modal
  (`shared/board-settings.js`, `renderFeaturesPane`), driven by a `FEATURE_FLAGS` registry so
  the same switchboard hosts future toggles (e.g. a Phase 3 manager-approval switch) — only
  Book Hours is wired to behavior today. The pane is gated on the **viewer's resolved role**
  (`viewerRole === 'owner'`), passed in via `BoardSettings.refresh(employeeId, role)` from each
  board's `captureSessionAndGreet()`. This is a **UI-level gate only** (the anon key can still
  write `shop_settings` directly) — same posture as every setting today; real enforcement waits
  on server identity (see [[settings]] §3/§4/§6).
- **How the advisor board reads it:** `bookHoursFeatureOn()` returns
  `!!BoardSettings.getShopSettings().feature_book_hours`, read on every check (so an owner flip is
  picked up on the **next board load**). It **fails safe to OFF** — when the settings read fails
  or the column is missing (pre-migration), `getShopSettings()` returns `feature_book_hours=false`.
- **What the switch gates (only two behaviors — everything else is already null-safe):**
  1. **The field.** `#cdRoBookHoursField` is `display:none` by default in the markup;
     `populateBookHours()` reveals it only when the flag is ON, and returns early (leaving it
     hidden, no read/paint) when OFF.
  2. **The gate.** `bookHoursGateForAdvance()` returns `{ ok:true }` immediately when the flag is
     OFF, so leaving Estimate is never blocked — the exact pre-feature behavior.
  With the field hidden, `book_hours` is never set, so the floor mirror, the Approval-Queue
  prefill, and the RO-close archive write all see `null` and degrade to today's behavior — they
  needed no extra gating.
- **ON** → the field shows and the "enter hours (or tick N/A) before leaving Estimate" gate
  enforces, exactly as §8 describes.
- **Second pay-hours source when ON — package R&R hours.** The Packages feature (see [[packages]])
  adds a **"Package" RO line** carrying `ro_line_items.rr_hours` — the pull/install tech-pay credit.
  That R&R-hours field is shown/captured **only when this Book Hours switch is ON** (packages still
  price normally when it's off, just without R&R hours). So a job's tech-pay hours can now come from
  two places — the RO's `book_hours` and each package line's `rr_hours` — both captured, neither yet
  summed into a per-tech report (§6, the next slice). Like `book_hours`, `rr_hours` never enters the
  customer price.

## Known gaps & open questions (as of 2026-08-07)
- **Per-tech / per-phase attribution is the next design slice** — one `book_hours` per RO can't be
  split between the diag tech and the repair tech, and tech names are last-write-wins with no
  history.
- Should the week be bucketed on work-finished or on pickup? Only `picked_up_at` is currently
  timestamped.
- Confirm whether lift `assigned_tech` is ever a per-job value or always the bay's station tech.

## Where it lives in the code / schema
- **Book hours (pay):** `repair_orders.book_hours` / `book_hours_na`
  (`migrations/20260730_ro_book_hours.sql`, **applied**). Capture + gate + mirror in
  `advisor-board.html`: field `#cdRoBookHoursField` (:1464, `display:none` by default),
  `populateBookHours` (:4575), `bookHoursCaptured`/`paintBookHoursHint` (:4560/:4563),
  `saveBookHours` (:5848), `mirrorBookHoursToFloor` (:4771), `bookHoursGateForAdvance` (:4785),
  RO-close archive write (:5350), Approval-Queue prefill `prefillFlagHoursFromBookHours` (:2002).
  Settings **RO & Pricing** pane `renderRoPricingPane` (`shared/board-settings.js:541`) has **no**
  rebuild editor.
- **Master switch:** `shop_settings.feature_book_hours`
  (`migrations/20260807_feature_book_hours_flag.sql`). Owner "Features" pane
  `renderFeaturesPane` / `saveFeatureFlag` + the `FEATURE_FLAGS` registry
  (`shared/board-settings.js:79/949/975`), gated on `viewerRole==='owner'` (set via
  `refresh(employeeId, role)` from each board's `captureSessionAndGreet()`). Advisor read:
  `bookHoursFeatureOn()` (`advisor-board.html:3635`) → `getShopSettings().feature_book_hours`.
- **Quoted labor (price, separate):** `ro_line_items` (`line_type`, `quantity`, `unit_price`) —
  `migrations/20260716_ro_foundation.sql`.
- **Flagged hours + approval (floor):** `advisor-board.html` `approveJob()` →
  `shopboard_*.flag_hours` + `approved_at`; archived by `gm-board.html sfArchivePickup()` (~3354).
- **Tech:** `repair_orders.technician` (`migrations/20260716_phase3_print_fields.sql`),
  `shopboard_*.assigned_tech`, mapped to `employees.name`; real writer FK is `service_writer_id`
  (`migrations/20260729_ro_service_writer.sql`).
- **Completion / archive:** `repair_orders.status` enum
  (`migrations/20260717_ro_status_closed.sql`, no timestamp); `completed_jobs`
  (`migrations/20260711_completed_jobs.sql`) — two writers (`advisor-board.html:5334`,
  `gm-board.html:~3388`).
- **Related docs:** `ro-checkin-tech.md`, `my-numbers.md`, `tech-board.md`, `comeback-warranty.md`,
  `settings.md`.

## Session change log
- 2026-07-30 — Created during the "shadow flat-rate" data-feasibility investigation. Mapped the
  three report inputs to real tables/columns, spot-checked 5 live ROs, found the report not yet
  buildable. Added a PROPOSED §8 capture design (book hours on every job) with a
  `rebuild_book_hours` lookup + `rebuild_type` selector. **Investigation/design only.**
- 2026-08-07 — **Book-hours capture BUILT; flat-rate rebuild-lookup DROPPED.** Rewrote the doc to
  the shipped design: hours are the **manual ALLDATA book time per vehicle**, typed on the RO —
  **no** `rebuild_book_hours` table and **no** `repair_orders.rebuild_type` column (removed from
  `advisor-board.html`, `shared/board-settings.js`, and the migration). Documented capture
  (`repair_orders.book_hours`/`book_hours_na`), the three-way state, the leaving-Estimate gate
  (shared by the Stage select + kanban drag), the floor `flag_hours` write-through mirror, the
  Approval-Queue prefill, and the RO-close archive write — all verified against code this session,
  and `repair_orders.book_hours`/`book_hours_na` confirmed **applied** live via the anon REST API.
  The `rebuild_book_hours` table + `repair_orders.rebuild_type` column were dropped from the
  migration file and app; both already existed in the DB from the earlier apply but are **empty**
  (0 rows / 0 non-null, confirmed live), so a manual DROP is staged for review. Per-tech / per-phase
  attribution remains the open next slice.
- 2026-08-07 — **Added the owner master on/off switch (§9), default OFF.** New
  `shop_settings.feature_book_hours` boolean (`migrations/20260807_feature_book_hours_flag.sql`,
  additive, reuses the anon-full-access `shop_settings` row — no new table/RLS). New owner-only
  **Features** pane in `shared/board-settings.js` (`renderFeaturesPane`/`saveFeatureFlag` +
  `FEATURE_FLAGS` registry, extensible for future switches), gated on the viewer's role via
  `BoardSettings.refresh(employeeId, role)` (wired on all four boards). Advisor board gates the
  Book Hours field visibility (`populateBookHours`, field now `display:none` by default) and
  `bookHoursGateForAdvance` on `bookHoursFeatureOn()`, which fails safe to OFF. OFF = pre-feature
  behavior (field hidden, gate never blocks); the mirror/prefill/archive stay null-safe. Verified in
  the browser: default OFF + field hidden, owner-only pane visibility (manager sees 4 panes, owner
  5), toggle defaults OFF, save fails safe pre-migration. Migration is written but **not yet
  applied** (Cris runs it by hand).
- 2026-08-07 — Cross-referenced the **Packages** feature ([[packages]]): its "Package" RO line adds
  `ro_line_items.rr_hours` (pull/install tech-pay), shown/captured only when this Book Hours switch
  is ON — a second pay-hours source alongside `book_hours`, neither yet summed into a report (§9).
  Also fixed the "N/A (no labor)" label overflow on the Book Hours field. No book-hours capture
  logic changed.
