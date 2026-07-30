# How the flagged-hours / "shadow flat-rate" data is wired (and where it isn't)

> Doc: `/docs/wiring/flat-rate-hours.md`
> Last updated: 2026-07-30 — verified vs commit `22e3a5a`
> Status: ✅ verified vs commit `22e3a5a` — schema re-read from `migrations/*.sql`, code paths
> re-checked in `advisor-board.html` / `gm-board.html` / `my-numbers.html`, and **every claim
> spot-checked against live rows this session** via the anon REST API (read-only, analytic
> columns only). **Investigation only — no app code changed** (only this doc + its File Cabinet
> registration).

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
