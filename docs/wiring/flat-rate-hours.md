# How the flagged-hours / "shadow flat-rate" data is wired (and where it isn't)

> Doc: `/docs/wiring/flat-rate-hours.md`
> Last updated: 2026-07-30 — verified vs commit `366665d`
> Status: ✅ §0–§7 verified vs commit `366665d` — schema re-read from `migrations/*.sql`, code
> paths re-checked in `advisor-board.html` / `gm-board.html` / `my-numbers.html`, and **every
> data claim spot-checked against live rows** via the anon REST API (read-only, analytic columns
> only). **§8 is a PROPOSED capture design — not built, pending approval.** No app code changed
> (only this doc + its File Cabinet registration).

## 0. In one line
The raw material for a per-tech per-week **flagged book-hours** report is meant to be three
fields — **who** (`assigned_tech`/`technician`), **how many flagged hours** (`flag_hours`), and
**when finished** (a completion `*_at`). Today **only "who" is partly present**: `flag_hours` is
captured on essentially **one** row shop-wide, there is **no reliable completion timestamp**, and
the estimate's labor `quantity` is **not a clean hours figure** — so a trustworthy weekly report
**cannot be built from existing data yet**.

## 1. The two parallel worlds this data lives in
There are **two separate systems**, linked only by the shared text key **`po`** (a CrisData RO
mints `ro_number` from 6000 and `po` mirrors it):
- **CrisData RO / estimate world** — `repair_orders` + `ro_line_items` (Josh builds the estimate
  here with ALLDATA book time). This is where *quoted labor* lives.
- **Shop-floor world** — `shopboard_lifts` / `shopboard_parking` / `shopboard_pickup`, the
  advisor **Approval Queue** (sets `flag_hours`), My Numbers (the tech's status buttons), and the
  **`completed_jobs`** archive. This is where *flagged hours*, *tech*, and *completion* are meant
  to be captured.
- ⚠ **ALLDATA still runs in parallel.** CrisData ROs start at 6000; ALLDATA is at ~5498 and is
  still the system of record for most jobs. Live counts this session: **38 `repair_orders`, ~20
  `labor` line items, 32 `completed_jobs` rows**. Any historical report built only on these
  tables covers a small, recent slice — most real jobs never entered them.

## 2. Input #1 — approved flagged hours (the core number). **Largely MISSING.**
- **Intended source: `shopboard_lifts.flag_hours` / `shopboard_parking.flag_hours`** (numeric),
  written by the advisor **Approval Queue** `approveJob()` (`advisor-board.html`) together with
  `status:'approved'` + `approved_at`. The advisor types the flagged hours by hand into the
  "Flag Hours" input at approval time. This — not the estimate — is the "approved flagged hours"
  figure. (`shopboard_pickup` has **no `flag_hours` column**; see `ro-checkin-tech.md` §2.)
- **Archived to `completed_jobs.flag_hours`** on pickup by `gm-board.html sfArchivePickup()`
  (falls back to the `undo_car` JSON snapshot because pickup rows lack the column).
- **⚠ Live reality (verified 2026-07-30): `flag_hours` is populated on exactly ONE row
  shop-wide** — `shopboard_parking` PO **5503** = **9.4h**, approved 2026-07-14, still
  `in-progress` (never completed). **Every other live floor row is null, and `flag_hours` is
  null on all 32 `completed_jobs` rows.** So the flagged-hours field exists but is effectively
  unused — there is no bank of approved-hours data to report on.
- **Quoted book hours are a *different, also-unreliable* figure:** `ro_line_items` rows with
  `line_type='labor'`, where **`quantity` = hours** and `unit_price` = rate. **But `quantity` is
  only real hours when the line is priced hourly.** Verified from live labor lines:
  - hourly lines *do* carry hours — "R&I TRANSMISSION" `qty 6 × $140`, "R&R OIL PAN"
    `qty 4 × $140`, "R&R FRONT AXLE ACTUATOR" `qty 2 × $140`;
  - but the shop's big-ticket jobs are entered **flat**: "R&R TRANS W/OVERHAUL (6L80)"
    `qty 1 × $4950`, "REMAN TRANSMISSION" `qty 1 × $4600`, "Shop Labor" `qty 1 × $4700`,
    "DIAGNOSTIC" `qty 1 × $150` — here **`quantity=1` is a flat-price line, not one hour.**
  - **⇒ `SUM(quantity)` over labor lines does NOT equal book hours.** It silently
    under-counts every flat-priced overhaul (the largest jobs) as "1".
- There is **no dedicated "book hours" or "approved hours" column** on `repair_orders`.

## 3. Input #2 — the tech. **Present but free-text, sparse, and not historical.**
- **Sources (all free-text names, no FK):** `repair_orders.technician` (text; added Phase 3),
  and `shopboard_*.assigned_tech` → archived as `completed_jobs.assigned_tech`.
- **Identity mapping:** by **string match to `employees.name`** — this is exactly how My Numbers
  scopes a tech's jobs (`assigned_tech == employees.name`). Live techs (`role='tech'`, active):
  **Alex, Alnardier, Cory** (plus inactive **Capote**). Names are currently distinct first names,
  so matching works — but a rename or a name collision would silently mis-attribute.
- **The only real employee FK on the RO is `service_writer_id`** (→ `employees.id`), and that is
  the **writer** (Josh), *not* the tech. Techs were deliberately left as the free-text shortcut.
- **⚠ Sparse & inconsistent (verified live):** `repair_orders.technician` is **null on most
  recent ROs**; `assigned_tech` appears as a real name, **`"Unassigned"`, `""`, or `null`** —
  three different "no tech" encodings to normalize.
- **⚠ Not historical / last-write-wins:** `assigned_tech`/`technician` hold only the *current*
  tech. A reassignment overwrites the prior tech with no history (there is no per-RO events
  table — see `ro-service-writer` migration note). A job worked by two techs, or handed off,
  credits only the final name.
- **⚠ Lift bays may carry a *station* tech, not a job tech:** live `shopboard_lifts` rows with
  `po=''`, `status='empty'` still have `assigned_tech` set (Alex/Cory) — i.e. the tech who owns
  that bay. Reading `assigned_tech` off a lift is not guaranteed to mean "did this job."

## 4. Input #3 — completion (the moment to credit a week). **No reliable timestamp.**
- **`repair_orders` has NO completion timestamp.** Its `status` enum reaches `closed`
  (`estimate → ro → invoice → closed`) but there is **no `closed_at` / `invoiced_at` /
  `completed_at`** column (confirmed across all migrations). The RO `*_at` columns are only
  `created_at, updated_at, arrived_at, declined_at, diagnosis_submitted_at,
  diagnosis_reviewed_at` (+ comeback stamps). So "closed" carries no *when*.
- **The intended "work finished" stamp is `tech_finished_at`** (floor row → `completed_jobs`),
  set by My Numbers "Mark Job Complete" (`waiting-pull`). **⚠ It is null on every live floor row
  and every archived job** — the My Numbers complete-flow simply isn't the path jobs take today
  (managers move cars via the floor dropdown, which writes raw `status` only, never a `*_at`
  stamp — see `tech-board.md` §6 / `status-mirror.js`).
- **The only populated completion signal is `completed_jobs.picked_up_at`** (archive event) plus
  `status`. But "picked up" is the customer collecting the car, which can **lag actual work
  completion by days** — so crediting flagged hours to a *week* by `picked_up_at` is
  approximate, and only exists for archived jobs.
- Raw floor statuses seen live include `done`, `qc`, `waiting-pull`, `waiting-part`, `delayed`
  (PO 6015 is raw `done`, PO 5511/5451 are `qc`) — "finished" is spread across several raw
  values, and only `waiting-pull`/pickup-membership map to "done" in the derived model.

## 5. Reconstruction spot-check (real ROs, 2026-07-30)
Attempting to rebuild **(tech, approved flagged hours, completed date)** for recent closed jobs:

| RO | RO status | Tech (source) | Flagged hrs | Book hrs from `ro_line_items` | Completion |
|---|---|---|---|---|---|
| **6011** | closed | Alnardier (`technician` + archive `assigned_tech`) | **null** | "diagnostic" `qty1×$150` → **flat, not hours** | `picked_up_at` 07-28; `tech_finished_at` null |
| **5490** | closed | Cory (archive) | **null** | axle `qty2×$140` **+** overhaul `qty1×$4700` (flat) → 2 real + unknown | `picked_up_at` 07-29; **duplicate archive rows** |
| **5513** | closed | (archive dup) | **null** | R&I `qty6×$140` **+** programming `qty1×$250` (flat) → 6 real + unknown | **duplicate archive rows** |
| **5503** | ro (in-progress) | Alex (floor) | **9.4** ← the only one shop-wide | "Shop Labor" `qty1×$4700` (flat) | none — never completed |
| **6015** | invoice | Cory (`technician`) | **null** | "DIAGNOSTIC" `qty1×$150` (flat) | none (not archived) |

**Cleanly available:** the tech name (for jobs that have one) and an approximate completed date
(`picked_up_at`) for archived jobs. **Missing/ambiguous:** the flagged-hours figure (null on all
but one non-completed job), true book-hours (flat lines defeat `SUM(quantity)`), and an exact
finish timestamp. **The single row that *has* flagged hours (5503) has no completion**, so not a
single job in the sample yields all three inputs together.

## 6. Gaps that block a trustworthy weekly per-tech report
1. **Flagged hours essentially uncaptured** — 1 of ~70 relevant rows. Without a consistent
   `flag_hours` capture (or a reliable hours source), the report's core number does not exist.
2. **`ro_line_items.quantity` conflates hours with a flat "1"** — the biggest jobs (overhauls)
   are flat-priced, so summing labor quantity under-counts book hours exactly where it matters.
3. **No per-RO completion timestamp; `tech_finished_at` unused** — only `picked_up_at` (archive)
   is populated, and it lags real completion, so week-bucketing is approximate.
4. **`completed_jobs` has duplicate rows** — 10 POs (5474, 5483, 5487, 5490, 5493, 5495, 5504,
   5508, 5510, 5513) appear **twice**: once from the old pickup archiver
   (`gm-board sfArchivePickup`, `source_table='shopboard_pickup'`) and once from the new RO-close
   archiver (`advisor-board`, `source_table='repair_orders'`). Each dedups only within its own
   `source_table`; there is **no cross-path dedup**. `diag_receipt` can add a third row per PO.
   **Any `SUM` over `completed_jobs` must dedup by `po` or it double-counts.** (The RO-close
   payload also does **not** write `flag_hours`/`tech_finished_at` at all — only billing dollars
   + `assigned_tech` — so that path structurally cannot carry flagged hours.)
5. **Tech attribution is free-text, sparse, non-historical, and sometimes a bay station** (§3):
   nulls/`"Unassigned"`/`""`, no employee FK, last-write-wins on reassignment, and lift
   `assigned_tech` can mean "owns the bay" not "did the job."
6. **Multi-tech jobs can't be split** — one `assigned_tech`/`technician` slot per job.
7. **Comebacks / warranty rework** — `repair_orders.parent_ro_id` links a comeback to its parent;
   `completed_jobs.comeback_flagged_at` / `warranty` flag them. Re-flagging hours on warranty
   rework needs an explicit policy (credit the tech again? exclude? charge back?) or the report
   will either double-pay or silently drop rework.
8. **ALLDATA parallel coverage** — only ~38 CrisData ROs / ~20 labor lines exist; most real jobs
   are still in ALLDATA and invisible to any report built on these tables.

## 7. What would have to be true first (design prerequisites — not built)
- A **consistent flagged-hours capture** at approval (make `flag_hours` required in the Approval
  Queue, or derive hours from an hours-typed labor line rather than a flat price).
- A **real completion timestamp** on the RO (a `closed_at`, or reliably-set `tech_finished_at`).
- **Dedup `completed_jobs` by `po`** (or a single archive writer) before any aggregation.
- **Tech identity as an FK** (or at least a normalized, non-null, non-station name) so per-tech
  totals are trustworthy.
- A **comeback/warranty rule** for how rework hours count.

## 8. PROPOSED capture design — book hours on every job (NOT built; approve first)
Decision taken: the advisor records **book hours on every RO/estimate**, and flat-priced
**rebuilds draw from a shop-set "rebuild type → standard book hours" table**. This section
proposes the minimal way to do that. **No code has changed.**

### 8.1 The one principle that makes it safe: book-hours is a PAY field, not a PRICE field
Customer **price** stays exactly as today — `Σ(quantity × unit_price)` over `ro_line_items`
(§2, `recalcTotals`). **Book-hours is a separate per-job number that never enters the money
math.** Because price = line math and pay = book-hours are *different columns with different
consumers* (invoice/totals vs. tech-pay/report), they cannot fight. A flat rebuild keeps its
`qty 1 × $flat` labor line (price unchanged) **and** carries, say, 12.0 book hours for pay.

### 8.2 Where the number lives — options
- **Option A (RECOMMENDED): one new column `repair_orders.book_hours numeric`**, captured on the
  **RO/estimate builder** (RO Board detail) — a single "Book Hours" field by the totals/labor
  area, where Josh already has the ALLDATA lookup open. It is the **system of record**; the floor
  `flag_hours` becomes a **write-through mirror** so today's pay/archive/report plumbing keeps
  working unchanged. Captures at the moment hours are known, one number per job, easy to gate.
- **Option B: reuse `flag_hours` only** — no new column; make the Approval-Queue "Flag Hours"
  input **required** (the disable-until-`>0` gate is already half-built, `onFlagHoursInput`) and
  auto-fill it. Smallest schema change, but capture happens at *approval on the floor row* (not
  at the estimate), misses ROs that never hit the Approval Queue, and still needs the RO-close
  archive taught to write it (§8.5). The number never lands on the RO itself.
- **Option C: per-labor-line hours** (`ro_line_items.book_hours` on labor lines, summed) — most
  granular, but summing across mixed flat + hourly lines **reintroduces the "which lines count"
  ambiguity** (§2) and is more surface than the single per-job number the report needs.

**Recommendation: Option A** — `repair_orders.book_hours` as the source of truth, **mirrored to
`flag_hours`** on approve/assign so nothing downstream has to change its read. One capture point,
decoupled from price, null-until-entered.

### 8.3 (a) Regular jobs — advisor types the ALLDATA hours he already looks up
- A **"Book Hours" field** on the RO detail. He looks up ALLDATA book time anyway; he types it
  here once. Stored on `repair_orders.book_hours`.
- **Hard to leave blank:** gate the **stage advance** (estimate → ro) *and/or* the **Approve**
  action on `book_hours` present (`> 0`), reusing the exact pattern already on `approveJob`
  (disable the button + red hint, `flag-hours-hint`). Treat **null = "not captured"**, distinct
  from a real 0 (a real job is never 0 hours).

### 8.4 (b) Rebuilds — auto-fill from a shop-set lookup
- **New table `rebuild_book_hours`** (a *list*, so its own table — not `shop_settings` columns):
  `rebuild_type text unique`, `book_hours numeric not null`, `active boolean default true`,
  `notes text`, timestamps; anon-full-access RLS + realtime (same pattern as every CrisData
  table). The shop **already names rebuilds by transmission code** in labor descriptions
  ("6L80", "68RFE", "9T50", "AW4", "4R75", "48RE" — seen in §2), so those are the natural keys.
- **Edited by Cris/Kevin** in **Settings** (Owner/GM board), the same home as `shop_settings`
  (tax rate, `default_labor_rate`) — a small add/edit/deactivate table editor.
- **Tagging a job as a rebuild so hours auto-fill:** add a nullable **`repair_orders.rebuild_type
  text`** with a selector on the RO detail populated from `rebuild_book_hours` (active rows).
  Picking a type **auto-fills `book_hours`** from the lookup (one tap). The existing
  `job_category = 'Rebuild'` tag (values today: Gen Auto / Rebuild / Diag) can drive whether the
  selector is **shown/required**; the specific `rebuild_type` is what resolves the hours.
- **Overridable but resolved-and-stored:** the advisor may override the auto-filled value; store
  the **resolved number on `repair_orders.book_hours`** (optionally a `book_hours_source`
  = `'typed' | 'rebuild_table'` for audit). See the trust note §8.6(2) — never re-read the table
  at report time.

### 8.5 The other write paths must carry the number
- **RO-close archive** (`advisor-board.html` ~5195, `source_table='repair_orders'`): today writes
  **no** `flag_hours` — must add `flag_hours: currentRo.book_hours` (and ideally a `book_hours`
  column on `completed_jobs`) so closed CrisData ROs land the pay number in the archive the report
  reads.
- **Pickup archive** (`gm-board.html` ~3353, `source_table='shopboard_pickup'`): already copies
  `flag_hours` from the floor row / `undo_car` snapshot — **works unchanged IF** `book_hours` was
  mirrored to the floor `flag_hours` at approve/assign (§8.2 Option A).
- **`approveJob`** (~2051): pre-fill its "Flag Hours" input from the RO's `book_hours` (join by
  `po`) so the advisor **confirms** instead of re-typing; keep the required gate as the backstop.
- Independent of this, per-week sums must still **dedup `completed_jobs` by `po`** (§6.4).

### 8.6 What would still make the captured hours untrustworthy
1. **Divergent copies** — `book_hours` (RO) vs `flag_hours` (floor) vs `completed_jobs`. Fix: one
   system of record (`repair_orders.book_hours`); the rest are write-through mirrors, never
   independently edited.
2. **Live lookup at report time** — if the report re-reads `rebuild_book_hours` later, editing the
   table would retroactively change past pay. Fix: **resolve and store** `book_hours` on the job
   at capture; the table is a default, not the historical source.
3. **Blank silently defaulting to 0** — looks captured, isn't. Fix: null-means-missing + the gate
   + a "missing book hours" list so nothing slips through unseen.
4. **Rebuild tag vs reality** — `job_category='Rebuild'` with no `rebuild_type`, or the wrong type
   picked. Fix: require `rebuild_type` when category = Rebuild; show the resolved hours to confirm.
5. **Silent override** — a wrong manual override is invisible. Optional `book_hours_source` flag.
6. **Still unsolved by this slice** (necessary, not sufficient — carry over from §6): multi-tech
   jobs can't split one number across techs; reassignment is last-write-wins with no history;
   comeback/warranty rework needs a credit rule; ALLDATA-parallel jobs that never become CrisData
   ROs get no `book_hours` at all.

### 8.7 Minimal build order (once approved)
1. `repair_orders.book_hours` (+ optional `rebuild_type`, `book_hours_source`) — additive, nullable.
2. `rebuild_book_hours` table + Settings editor (Owner/GM).
3. RO-detail "Book Hours" field + rebuild-type auto-fill + the required gate.
4. Mirror to floor `flag_hours` on approve/assign; teach the RO-close archive to write it.
5. (Separate) `completed_jobs` po-dedup before any aggregation.

## Known gaps & open questions (as of 2026-07-30)
- Is the intended hours figure the advisor's `flag_hours` (labor **sold/flagged**) or the
  estimate's book time (labor **quoted**)? They differ, and today neither is clean.
- Should the week be bucketed on work-finished or on pickup? Only pickup is currently timestamped.
- Confirm whether lift `assigned_tech` is ever a per-job value or always the bay's station tech.

## Where it lives in the code / schema
- **Quoted labor:** `ro_line_items` (`line_type`, `quantity`, `unit_price`) — schema
  `migrations/20260716_ro_foundation.sql`; entered in `advisor-board.html` RO line editor.
- **Flagged hours + approval:** `advisor-board.html` `approveJob()` → `shopboard_*.flag_hours` +
  `approved_at`; archived by `gm-board.html sfArchivePickup()` → `completed_jobs.flag_hours`.
- **Tech:** `repair_orders.technician` (`migrations/20260716_phase3_print_fields.sql`),
  `shopboard_*.assigned_tech` (live schema), mapped to `employees.name`; real writer FK is
  `service_writer_id` (`migrations/20260729_ro_service_writer.sql`).
- **Completion / archive:** `repair_orders.status` enum
  (`migrations/20260717_ro_status_closed.sql`, no timestamp); `completed_jobs`
  (`migrations/20260711_completed_jobs.sql`) — `picked_up_at`, `tech_finished_at`, `flag_hours`,
  `assigned_tech`, billing columns; two writers (`advisor-board.html` ~5195, `gm-board.html`
  ~3353).
- **Related docs:** `ro-checkin-tech.md` (tech assignment, pickup no-`status` quirk),
  `my-numbers.md` (the tech complete-flow that would set `tech_finished_at`), `tech-board.md`
  (raw-vs-derived status), `comeback-warranty.md` (comeback/warranty chain).

## Session change log
- 2026-07-30 — Created during the "shadow flat-rate" data-feasibility investigation. Mapped the
  three report inputs to real tables/columns, spot-checked 5 live ROs, and found the report is
  **not yet buildable**: `flag_hours` captured on one non-completed row shop-wide, labor
  `quantity` conflated with flat "1", no RO completion timestamp (`tech_finished_at` unused, only
  `picked_up_at`), duplicate `completed_jobs` rows from two archive writers, and free-text /
  non-historical tech attribution. **Investigation only — no app code changed.**
- 2026-07-30 — Added **§8 PROPOSED capture design** (book hours on every job): recommends a new
  `repair_orders.book_hours` as the pay-only source of truth (decoupled from the line-item
  price), a shop-set `rebuild_book_hours` lookup keyed on transmission code with a
  `repair_orders.rebuild_type` selector that auto-fills, a required-gate reusing the `approveJob`
  pattern, mirroring to floor `flag_hours` + the RO-close archive, and the trust risks
  (divergent copies, live-lookup-at-report-time, blank-as-0). **Design only — not built,
  pending approval; no code changed.**
