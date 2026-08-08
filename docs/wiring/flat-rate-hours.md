# How the flagged-hours / book-hours (tech-pay) data is wired

> Doc: `/docs/wiring/flat-rate-hours.md`
> Last updated: 2026-08-08 — verified vs commit `8c93cee` (merged to main)
> Status: ✅ verified vs code AND live schema this session. **`book_hours` capture is
> BUILT** and, as of the **Hours Engine Part 1**, is a **read-only auto-total from the
> lines** (§8) — not hand-typed. Per-line **tech credit** (`ro_line_items.line_tech_id`)
> and a live **weekly per-tech Billed Hrs rollup on the Manager board** (§10) now exist;
> all behind the owner Book Hours switch, default OFF (§9). §1–§7 remain the original
> data-feasibility findings (the "why"). **The flat-rate / rebuild-lookup idea was
> dropped** — the `rebuild_book_hours` table + `repair_orders.rebuild_type` column are
> staged for a manual DROP. §8 = capture (now auto-total), §9 = the switch, §10 = the
> rollup.

## 0. In one line
A per-tech per-week **billed book-hours** report needs three fields — **who**
(`technician` + per-line `line_tech_id`), **how many book hours**
(`repair_orders.book_hours`, now an **auto-total** of the labor + package-R&R lines), and
**when finished** (a completion date). As of Hours Engine Part 1 the **hours auto-total
from the RO lines** (no hand-typing), each labor line can **credit a specific tech**, and
the Manager board shows a real **Billed Hrs** column per tech for the current week (§10),
bucketed by a **stable set-once `repair_orders.closed_at`** (stamped the first time an RO is
invoiced/closed and never moved). (§4/§6 below describe the *original* pre-Part-1 state.)

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
> **Superseded by §10 (Hours Engine Part 1):** `repair_orders.closed_at` now provides a
> set-once completion stamp for the Billed-Hrs week. §4 records the *original* findings.
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

## 8. Book-hours capture — now a READ-ONLY AUTO-TOTAL from the lines
**As of Hours Engine Part 1** the advisor no longer types book hours. The RO-level Book Hours field
is a **read-only auto-total** = `Σ (each Labor line's hours) + Σ (each Package line's R&R hours)`,
recomputed live as lines change. Kevin adjusts on the **line** (a Labor line's Hours, or a Package
line's R&R via Rebuild Units & Prices) and the total follows. (Where the hours come from — ALLDATA
per vehicle — is unchanged; they're just entered on the labor line now, which is also the billed
`quantity`.)

### 8.1 The one principle that makes it safe: book-hours is a PAY field, not a PRICE field
Customer **price** stays exactly as today — `Σ(quantity × unit_price)` over `ro_line_items`
(`recalcTotals`). **`book_hours` never enters the money math.** For a **labor** line the hours ARE
the `quantity` (so they also bill at `quantity × rate`); for a **package** line the R&R hours
(`rr_hours`) are pay-only and never touch price. The auto-total is a pay number; the invoice totals
are the price number.

### 8.2 The number + the N/A flag
- **`repair_orders.book_hours`** holds the **auto-total** (kept in sync from the lines; `0` when
  there are no labor/package hours yet).
- **`repair_orders.book_hours_na`** is the one **manual RO-level control** left — ticking it marks a
  genuine **parts-only** job (`book_hours` → null, no hours required). Unticking restores the
  auto-total.
- The floor mirror writes `flag_hours` = the total when present, NULL when N/A.

### 8.3 Where the number lives and flows
- **System of record:** `repair_orders.book_hours` / `book_hours_na`
  (`migrations/20260730_ro_book_hours.sql`, applied). The **line hours** that feed it live in
  `ro_line_items` (`quantity` on labor, `rr_hours` on package).
- **UI:** the **Book Hours** field on the RO detail (`#cdRoBookHoursField`) — a **read-only total**
  `#cdRoBookHoursTotal` + the `#cdRoBookHoursNA` checkbox. `bookHoursAutoTotal()` sums the lines;
  `updateBookHoursAuto()` (`advisor-board.html:4646`, called from `renderLines()` on every line
  change) paints the total and **persists it** to `repair_orders.book_hours` (+ mirrors to floor)
  when it differs; `populateBookHours()` shows the field only when the switch is on.
- **Write-through mirror / archive-on-close / Approval-Queue prefill:** unchanged — they still read
  `repair_orders.book_hours`, which is now the auto-total instead of a typed value.

### 8.4 The gate — a light guardrail on 0
`bookHoursGateForAdvance(roId, po)` (`advisor-board.html:4875`), shared by the RO-detail **Stage
select** and the **kanban drag**, blocks leaving Estimate when the **auto-total is 0 AND N/A is not
set** (`(book_hours == null || <= 0) && !book_hours_na`). A genuine parts-only RO ticks N/A. It
reads the persisted total fresh (so the kanban drag works without the lines in memory), returns
`{ ok:true }` pre-migration / feature-off, and never touches price.

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
  two places — the RO's `book_hours` and each package line's `rr_hours` — both feed the §10 rollup.
  Like `book_hours`, `rr_hours` never enters the customer price.

## 10. Per-tech BILLED HOURS rollup — Manager board (BUILT, Hours Engine Part 1)
The Manager board **Technicians** table now shows a **real "Billed Hrs"** column per tech for the
current week — behind the Book Hours switch (OFF → the old sample values, so the board looks exactly
like before). Clocked Hrs / Efficiency / time-punches stay **sample** (no time-clock source yet);
the header tags and the banner say which is live vs sample.

- **Where:** `gm-board.html` `computeBilledHours()` (:2171) → `renderTechnicians(..., billedHrs)`
  (:2213). `computeBilledHours` returns **null when the feature is off** (→ sample), else
  `{ techName: hours }`.
- **Per-tech billed hrs** = `Σ` labor-line hours credited to that tech (`line_tech_id` → the
  employee's name, else the RO's `technician`) `+ Σ` package `rr_hours` on ROs where they're the
  RO's assigned tech. Package R&R always credits the RO tech (the rebuilder is counted by units
  later, not here). Hours on ROs with **no** assigned tech are credited to no one.
- **Week:** **Sunday–Saturday, America/New_York** — the SAME convention as the bookkeeping board's
  Financial Pulse. `nyWeekSunSat()` (:2159) computes the Sun–Sat window; `nyDateOf(ts)` (:2154)
  folds a timestamp to its NY calendar date.
- **Completion timestamp — the STABLE, set-once `repair_orders.closed_at`.** The rollup buckets
  each RO by `closed_at` (folded to a NY date), scoped to `status IN ('invoice','closed')` ("billed
  or closed", regardless of customer payment). `closed_at` is **stamped once the first time an RO
  enters invoice/closed and never overwritten** — enforced by a DB trigger
  (`crisdata_stamp_ro_closed_at`, `migrations/20260807_ro_closed_at.sql`), so editing a closed RO
  later does **not** move its hours to another week (the pay-driving number is fixed).
  `completed_jobs.picked_up_at` was rejected: it only exists for picked-up jobs (invoice-status ROs
  aren't picked up) and links by `po` with possible duplicate rows. A one-time backfill seeds
  existing invoice/closed rows from `updated_at`.
- **Resilience:** the RO query asks for `closed_at` and the line query for `line_tech_id`; each
  **re-queries without the column** if it isn't migrated yet (bucketing falls back to `updated_at`;
  labor all credits the RO tech), caching the probe result per session. Verified live: week Aug 2–8,
  billed `{Cory: 9, Alex: 3}`, matching an independent DB sum; OFF → sample.

## 11. Hours Engine Part 2 — advisor GP + commission (separate subsystem)
Part 2 builds a per-**advisor** weekly **gross-profit** rollup and the commission it drives
(advisor "My Commission" card; owner/bookkeeper "Commission & Payout" card), behind its own
owner **Advisor Commission** switch (default OFF). It **reuses this doc's bucketing verbatim**
— stable `closed_at`, Sun–Sat NY, `status IN ('invoice','closed')` (§10) — but keys on the
RO's **advisor** (`service_writer_id`), not the tech, and computes **money** (labor + parts
markup + package margin), not hours. Fully documented in [[advisor-commission]].

## Known gaps & open questions (as of 2026-08-07)
- **Multi-tech / per-phase** is now *partly* addressed: a labor line can credit a specific tech
  (`line_tech_id`), but a single line still can't split across techs, and diag-vs-repair phase
  isn't modeled.
- Package R&R always credits the RO's assigned tech (the rebuilder-by-units count is a later step).

## Where it lives in the code / schema
- **Book hours (pay), now auto-totaled:** `repair_orders.book_hours` / `book_hours_na`
  (`migrations/20260730_ro_book_hours.sql`, applied). In `advisor-board.html`: read-only field
  `#cdRoBookHoursField` / `#cdRoBookHoursTotal`, `bookHoursAutoTotal` (:4616),
  `updateBookHoursAuto` (:4646, called from `renderLines`), `paintBookHoursDisplay` (:4634),
  `populateBookHours` (:4659), the N/A toggle handler, `mirrorBookHoursToFloor`,
  `bookHoursGateForAdvance` (:4875, blocks on 0), RO-close archive write, Approval-Queue prefill.
- **Per-line tech credit:** `ro_line_items.line_tech_id` (`migrations/20260807_ro_line_tech.sql`,
  **applied**). Labor pop-up picker `lineTechPickerHtml` (:5245), saved in `saveLineModal`; see
  [[ro-line-items]] §5.
- **Stable completion stamp:** `repair_orders.closed_at` + trigger `crisdata_stamp_ro_closed_at`
  (`migrations/20260807_ro_closed_at.sql`, **applied** — verified live 2026-08-08: column
  present, stamped on all 33 invoice/closed ROs) — set once on first invoice/closed.
- **Weekly Billed Hrs rollup:** `gm-board.html` `computeBilledHours` (:2174, buckets by
  `closed_at`), `nyWeekSunSat` / `nyDateOf`, `renderTechnicians`, `bookHoursFeatureOnGm`; column
  probes cached via `lineTechColAvailable` / `closedAtColAvailable`.
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
- 2026-08-07 — **Stable Billed-Hrs bucketing.** Switched the §10 rollup from `updated_at` (drifts on
  edit) to a **set-once `repair_orders.closed_at`** — stamped the first time an RO hits
  invoice/closed by a DB trigger, never overwritten (`migrations/20260807_ro_closed_at.sql`, additive
  column + backfill + trigger; **unapplied**). Rejected `completed_jobs.picked_up_at` (misses
  invoice-status ROs; links by `po` with dups). `gm-board` buckets by `closed_at` with a cached
  fallback to `updated_at` pre-migration. Verified live: pre-migration fallback returns the same
  `{Cory:9, Alex:3}`, closed_at probe caches after one miss. (`line_tech_id` was applied since Part 1.)
- 2026-08-07 — **Hours Engine Part 1.** Book Hours became a **read-only auto-total** of the RO's
  labor hours + package R&R hours (rewrote §8; `bookHoursAutoTotal`/`updateBookHoursAuto`, persisted
  to `repair_orders.book_hours` on every line change); the leaving-Estimate **gate now blocks on a
  0 total** (N/A escape unchanged). Added a **per-line tech credit** picker + `line_tech_id`
  (`20260807_ro_line_tech.sql`, unapplied). Built the **weekly per-tech Billed Hrs rollup** on the
  Manager board (§10) — Sunday–Saturday NY week, bucketed by `repair_orders.updated_at` of
  invoiced/closed ROs (disclosed proxy; no `closed_at` exists). Verified live: auto-total 14h
  (14→16→14 on an edit, reverted); billed `{Cory:9, Alex:3}` matched an independent DB sum; OFF →
  sample. Migrations `20260807_ro_line_tech.sql` (+ the earlier `unit_cost`) unapplied.
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
