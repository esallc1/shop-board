# How the Manager board Overview card library is wired

> Doc: `/docs/wiring/gm-overview-cards.md`
> Last updated: 2026-09-05 — created with the retirement of the six `completed_jobs`-backed
> cards. Verified vs the commit that adds it.
> Status: ✅ BUILT + verified in-browser this session (the real `CARD_LIBRARY`,
> `mergeOverviewLayout`, `renderOverviewSkeleton` and `renderCustomizeList` driven against a
> simulated pre-change saved layout).

## 0. In one line
The Manager board's **Overview** tab is a per-employee, re-orderable grid of KPI cards; which
cards you see is a JSONB layout saved against **your** employee id, and what a card is allowed
to be is decided by a single in-file card library.

## 1. The two halves — library vs layout
Two things decide whether a card appears, and they are not the same thing:

- **`CARD_LIBRARY`** (`gm-board.html:1461`) — the shop-wide definition of every card that can
  exist: `id`, `label`, `group`, `status`, plus presentation (`icon`, `theme`, `chart`, `type`).
  One source of truth, same for everyone.
- **`dashboard_preferences.layout`** — a per-employee JSONB array of
  `{ card_id, visible }`, in display order, keyed by `employee_id`. This is **per person**:
  Cris's Overview and Kevin's Overview are different rows.

**The library always wins.** Every render and save path re-checks `CARD_BY_ID[...].status`, so
a `status` change here takes effect for every employee on their next load — no DB edit, no
asking anyone to open Customize. This is the mechanism to reach for when a card has to come off
*everyone's* board (§4).

## 2. `status` — the three values
| `status` | Renders on Overview? | Listed in Customize? | Persisted on Save? |
|---|---|---|---|
| `live` | yes, if `visible` | yes, with a checkbox + reorder arrows | yes |
| `comingSoon` | **never** | yes, greyed out, disabled, "Coming Soon" tag | **never** |
| `retired` | **never** | **never** | **never** (dropped from the row on next Save) |

- `renderOverviewSkeleton` (`gm-board.html:1573`) filters `c.status === 'live'`.
- `renderCustomizeList` (`gm-board.html:1978`) returns `''` for `retired` **before** the group
  header is emitted, so a group whose members are all retired prints no heading at all.
- The Save handler (`gm-board.html:2059`) persists only `live` entries, so a stale
  `retired` entry left in someone's saved JSONB self-cleans the next time they hit Save.
- `mergeOverviewLayout` (`gm-board.html:1527`) never *adds* a `retired` card to a layout.

## 3. `mergeOverviewLayout` — how a saved layout meets a changed library
- No saved row → `DEFAULT_OVERVIEW_LAYOUT` (every `live` card, visible, in library order).
- A saved row → that array, **plus** any library card it has never seen, appended **hidden**,
  so a newly-added card never silently switches itself on for an existing employee.
- The one exception is `forceDefaultOn` (Core Bank today): appended **visible**, so it shows up
  once without the employee opening Customize. It only forces on the first time — after that
  the card is in the saved row and behaves normally.

## 4. The retired 'Completed Jobs' group (2026-09-05)
Six cards — **Comeback Rate**, **Avg Days to Complete**, **Jobs Completed This Week**,
**Jobs Completed This Month**, **Jobs by Category**, **Warranty Job Count** — are `retired`.
They were the only consumers of an unbounded `completed_jobs` read in `loadAndRender()`, and
they failed on two independent counts:

1. **No category at source.** 68 of 83 archived jobs have no `job_category`, and there is no
   category field anywhere on the RO for an advisor to set one. "Jobs by Category" reported on
   a column nobody can fill; the rest inherited the same thin archive.
2. **The silent 1,000-row cap.** The read had no `.limit`/`.range`/date filter **and no
   `.order()`**, so PostgREST returns the first 1,000 rows in heap order — the **oldest**
   1,000. Past that these do not drift low, they **freeze in the shop's past**: "Jobs Completed
   This Week/Month" would read `0` forever while the shop closed jobs daily. Nothing on screen
   signals the cap (see §5).

The read is gone with them — `gm-board.html` no longer touches `completed_jobs` at all.

**Restoring them needs BOTH fixed**: a real category field on the RO, and a paged or
date-windowed read (`.range()` in a loop, like `window.cdFetchAllCustomers`). Flipping one back
to `live` without the other just re-ships a confidently wrong number to the GM.

## 5. Known gaps & open questions (as of 2026-09-05)
- **Nothing in this board signals a truncated read.** No row count beside a total, no
  "showing X of Y", no `{ count: 'exact' }` next to any KPI. The nearest thing was accidental:
  the retired deltas printed `"N of 1000 jobs"` — a suspiciously round denominator that reads
  as data, not as a warning, and was the denominator of the same wrong ratio.
- **`completed_jobs` has duplicate rows** by `po` (see [[flat-rate-hours]] §5) — the old pickup
  archiver plus a `diag_receipt` row can put the same job in three times. Any future
  aggregate over this table must dedup by `po`, and the 1,000 cap arrives at *fewer* than
  1,000 real jobs.
- **No test coverage.** `npm test` globs `api/*.test.js` and `shared/*.test.js` only; none of
  this card logic lives in a testable module, so it is verified by driving the real functions
  in a browser.
- The surviving cards read the live floor tables (`shopboard_lifts`/`_parking`/`_pickup`,
  2–12 rows) and `core_charges` — nowhere near the cap.

## Where it lives in the code
- `gm-board.html` — `CARD_LIBRARY` (:1461), `CARD_BY_ID` (:1515),
  `DEFAULT_OVERVIEW_LAYOUT` (:1520), `mergeOverviewLayout` (:1527),
  `renderOverviewSkeleton` (:1573), `kpiCardHTML`/`chartCardHTML`/`panelCardHTML`,
  `loadAndRender` (:1805), `loadDashboardPreferences` (:1953),
  `renderCustomizeList` (:1978), the Save handler (:2050).
- `dashboard_preferences` — `migrations/20260711_dashboard_preferences.sql`.
- Related: [[manager-board]] (the Technicians tab, a different subsystem on the same board),
  [[intake-wizard]] §5 (the repo-wide unbounded-read audit), [[flat-rate-hours]]
  (`completed_jobs` archive caveats).

## Session change log
- 2026-09-05 — **Doc created.** Retired the six `completed_jobs`-backed cards via a new
  `status: 'retired'` (§2, §4) and deleted the unbounded `completed_jobs` read from
  `loadAndRender()`; removed the now-orphaned `startOfMonth` helper. Verified in-browser
  against a simulated pre-change saved layout with all six explicitly `visible: true`: none
  render, no `kpi-<id>-val` node exists, the Customize panel lists none of them and prints no
  "Completed Jobs" heading, and a Save drops them from the persisted JSONB. Bay Utilization,
  Open Repair Orders, RO Aging (7+ Days), New Jobs This Week, Jobs by Technician and Core Bank
  are untouched.
