# How the Tech Board (dispatcher) is wired

> Doc: `/docs/wiring/tech-board.md`
> Last updated: 2026-09-19 — **§8 added: why closed jobs used to linger here, and the fix**
> (closing an RO now takes its car off the floor; one-time ghost cleanup). Branch
> `fix/close-clears-floor`, **shipped to prod at `929b6ee`**; prod ghost cleanup **done** (30 → 16
> cars on this board, 2026-09-19); verified
> vs commit `993b51e` on `test.*` (change log).
> §2 re-checked vs `loadAll`; rest not re-verified this session.
> Earlier: 2026-08-21 — §2a added (columns key off ASSIGNMENT, not role); verified vs
> commit `d67d506`. Previously 2026-07-30 — verified vs commit `8ec2164`
> Status: ✅ verified vs commit `8ec2164` — checked against `crisdata-techboard.html`,
> `my-numbers.html`, `gm-board.html`, and the floor-table columns. Investigation-only capture
> of Kevin's "let the manager edit from the tech board" request (§7) — **no code changed**.

## 0. In one line
A **dispatcher** view of every car on the shop floor grouped by tech, where you **drag a card
onto a tech to assign it**; the per-job detail **modal is read-only**. The tech's own status
changes come from **My Numbers** (their phone), not here.

## 1. What it is / where it's used
- File: `crisdata-techboard.html` ("CrisData · Tech Board — dispatcher · Beta").
- Embedded as the **"Tech Board" tab on `advisor-board.html`** (an `<iframe src="crisdata-techboard.html">`).
  `gm-board.html` also has a related **"Tech Status"** tab (`#view-techstatus`).
- **Techs do NOT use this board** — they use `my-numbers.html` on their phones. The tech board's
  audience is the **advisor / manager / dispatcher**.

## 2. What it reads
- The three floor tables — `shopboard_parking`, `shopboard_lifts`, `shopboard_pickup` — plus
  `employees_visible` where `role='tech'` (the *seed* for the columns — see §2a). Columns per job: `po, vehicle,
  work, notes, tech_notes, job_category, customer, warranty, assigned_tech, status` (+ the
  `*_at` stamps). `shopboard_pickup` has **no `status`** (see `ro-checkin-tech.md` §2).
- It resolves **no identity for the current viewer** — no session phone, no `CHAT_IDENTITY`, no
  role. It only loads the *tech roster* for the columns. (It's also ungated on its own; it
  relies on being embedded behind the parent board.) → **it can't tell who's looking, so it
  can't role-gate anything today.** (§7)

## 2a. Columns = the tech roster UNION whoever is actually assigned

**A column exists because work is assigned to that name, not because that name has
`role='tech'`.** The roster only seeds the list, so a tech with zero jobs still gets a column;
the union then adds anyone holding a job who is not on it.

That covers the two cases where roster and assignment legitimately disagree:
- someone covering tech work in another role (the owner doing diag while short-staffed),
- someone **retired** who still holds a live job — retiring removes them from the future, not
  the past ([[employee-roster]] §6a).

**This was a real defect, fixed 2026-08-21.** Bucketing was roster-only, and a job assigned to
any other name fell through to *no column at all* — while still counting toward the **Assigned**
tally. The board's own counter disagreed with its own columns, and the job appeared nowhere on
the screen whose entire purpose is showing what is in flight. It had been deferred on purpose
("not shown as a phantom column this slice"); a column for someone unexpected is strictly better
than a job that exists nowhere.

`techColHtml` already falls back to initials when `photo_url` is null, so an off-roster column
needs no new UI. Off-roster entries are marked `offRoster: true` if a future slice wants to
style them.

**Verified on sandbox 2026-08-21:** with 5 floor rows held by retired names plus one job
assigned to an owner-role account, the board rendered 2 columns covering 2 of 8 assigned jobs
before the fix, and 5 columns covering 8 of 8 after — counter and columns agreeing.

## 3. "Status" is DERIVED, not a plain field
The chip you see (New / Diagnosing / Awaiting Approval / Approved — Go Ahead / In Progress /
Complete) is **derived** by `deriveLocalStatus(row, table)` — copied **verbatim** from
`my-numbers.html` `sbStatusToLocal()` so the dispatcher and the tech's phone can never disagree.
It reads the **raw `status` column PLUS the `*_at` timestamps**:
- `waiting-tech` → `new`, or `diagnosing` **if `diagnosing_at` is set**;
- `waiting-auth` → `waiting`; `approved` → `approved`; `in-progress` → `in_progress`;
  `waiting-pull` → `done`; any pickup row → `done`.

So **status is a small state machine, not one editable value.** Two display states (`new` and
`diagnosing`) share the same raw `status` (`waiting-tech`) and differ **only by `diagnosing_at`**.
Setting the chip you want therefore means writing the raw `status` **and** the right `*_at` stamp
— which is exactly what My Numbers does (§6). Writing the raw column alone would desync the chip
and the tech's "time in state."

## 4. "Category" is a plain field
`job_category` is a plain text tag on the floor row (Rebuild, R&R, etc.) — no state machine.
Today it's written on the **gm-board "Shop Floor" tab** (the manager's
floor editor); `my-numbers.html` reads it but does not write it. So editing category is
low-risk — last-write-wins, nothing derived depends on it.

**Not the RO's category.** Since 2026-09-19 the RO has its own `repair_orders.job_category`
(`Transmission rebuild` / `General repair`, set on the advisor RO detail — [[ro-checkin-tech]] §7).
The two are **separate on purpose**: nothing copies the RO value onto the floor row or back, so
this board's "Category" line (and the Manager board pools) still show only the floor tag.

## 5. What the board WRITES today (it's not fully read-only)
Dragging a card onto a tech (or onto "Unassigned") calls **`assignTechCore`** (the same
pickup-aware function documented in `ro-checkin-tech.md` §4) → writes `assigned_tech` and nudges
a pre-work row to `waiting-tech`. So the board **already writes on assignment** — only the
**job-detail modal (`openJob`) is read-only** ("Read-only view. Techs update jobs from My
Numbers.").

## 6. The tech's edit path — My Numbers (`my-numbers.html`)
`writeJobStatus(job, newLocalStatus, extraFields)` → `update({ status:
localStatusToSb(newLocalStatus), ...extraFields })` on the floor row, where `extraFields` carries
the `*_at` stamp for that transition (e.g. new→diagnosing stamps `diagnosing_at`; approved→
in_progress stamps `tech_started_at`). `localStatusToSb` is the reverse of §3. This is the
single writer that keeps `status` + timestamps consistent.

## 7. Manager-edit request (Kevin) — findings & options (NOT built)
**Kevin (manager) wants to tap a job on the tech board and edit status / category; the modal
being read-only makes it feel pointless.**

**Findings**
- The "read-only because techs use it" rationale is only half-true: **techs don't use the tech
  board** (they use My Numbers), and the board **already writes** on drag-assign (§5). So a
  manager editing from here is not inherently against the design — the modal is just Slice-1
  read-only.
- **The manager already has an edit path:** the **gm-board "Shop Floor" tab** lets the manager edit floor `status` + `job_category` directly. Kevin's
  capability exists — just on a different screen than the card he tapped.
- **Category** is safe to make editable inline (plain field, last-write-wins). **Status** is
  not — it's the derived state machine (§3); a naive status dropdown that writes the raw column
  would desync the chip and could **stomp a tech's live progress** mid-job.
- **No role gate exists** (§2): the board can't currently tell a manager from anyone else, and
  it's ungated, so "only managers can edit" can't be enforced without adding identity first.

**Options (pick per appetite; none applied)**
1. **Zero-code:** point Kevin at the existing **gm-board → Shop Floor** editor for status/category.
2. **Editable category in the modal** (small, low-risk): add a `job_category` `<select>` to the
   `openJob` modal that writes the floor row. No state-machine conflict.
3. **Editable status in the modal** (higher-risk): do **not** add a raw dropdown — reuse the My
   Numbers writer (`status` + the matching `*_at` stamp) so the derivation stays consistent, and
   warn that it overrides the tech's live state. Or open the gm-board floor editor from the modal
   instead of adding a third status-write path.
4. **Role-gate first (prerequisite for 2/3):** give the tech board the current viewer's role —
   e.g. pass identity from the embedding advisor/gm board via the iframe (query param / postMessage),
   or add a session-phone→`employees.role` lookup like the office boards — and show edit controls
   only for manager/advisor.

**Recommended approach**
Make **category** editable in the modal (option 2) as the quick win, **gated to manager/advisor**
via a viewer-role check added to the board (option 4). Leave **status** on the two writers that
already handle the state machine correctly — the tech's My Numbers and the manager's gm-board
Shop Floor tab — or, only if editing status from the tech board is truly wanted, route it through
the My Numbers transition writer (option 3), never a raw dropdown.

## 8. Closed jobs lingering on the board ("ghosts") — cause and fix (Kevin, Aug 6 / 13 / 26)
**What Kevin saw.** "completed jobs that have already left the shop and are no longer on ro board
are still on tech board" (Aug 6); "LOTS OF OLD/COMPLETED JOBS STILL SHOW" (Aug 13); "fix old ROs
still showing up in the unassigned pool" (Aug 26, middle clause of the pools request). One bug.

**Why.** This board lists whatever is in the three floor tables (`loadAll`, §2) and **never reads
`repair_orders`** — it only drops rows with a blank `vehicle`. So a car is shown until its floor row
goes. Until 2026-09-19 the only thing in live use that removed a floor row was the advisor board's
**Off lot** button (Ready-for-pickup cards). Closing an RO from the RO detail's **Stage dropdown** —
how the shop closes most ROs — left the row behind. On prod on 2026-09-19 that was **14 of the 30
cars** on this board, closed 10–42 days earlier, all unassigned (hence "the unassigned pool"). The
same rows also showed in the advisor **Approval Queue** (floor `waiting-tech` / `waiting-auth`) and
the Manager board's **Tech Status**, which read the floor the same way.

**The fix (on the write side, not here).** Closing an RO now takes its car off the floor — one close
path, `setStage('closed')`, used by the Stage dropdown and Off lot alike; a lift bay is cleared,
never deleted ([[ro-checkin-tech]] §8, `shared/floor-clear.js`). This board is **unchanged**: it
still shows exactly the floor, and the floor is now right. A display-side "hide closed ROs" filter
was considered and not built — it would need a `repair_orders` read in every floor reader,
including My Numbers, which runs without a login and would break under security Phase 3's
staff-only `repair_orders`.

**The ghosts already there** are removed once by hand-run SQL
(`migrations/20260919_floor_ghosts_cleanup_{SANDBOX,PROD}.sql`, [[ro-checkin-tech]] §8).

**Still shown until a later decision:** declined estimates and diag-fee-receipt cars — neither is a
close, so nothing removes their floor rows.

## Known gaps & open questions (as of 2026-07-30; §8 as of 2026-09-19)
- §8: declined-estimate / diag-fee-receipt cars stay on the board until closed or removed by hand.
- No viewer identity/role on the tech board (§2, §7) — the blocker for safe manager-only editing.
- The read-only modal's premise ("techs update from My Numbers") understates that the board
  already writes on assignment (§5).
- `job_category` has no shared writer/module — it's edited in gm-board's Shop Floor tab only.

## Where it lives in the code
- Dispatcher: `crisdata-techboard.html` — `deriveLocalStatus`, `toJob`, `openJob` (read-only
  modal), `assignTechCore` (drag-assign write), the drag/drop wiring.
- Tech phone flow: `my-numbers.html` — `sbStatusToLocal` / `localStatusToSb` / `writeJobStatus`.
- Manager floor editor (status + category today): `gm-board.html` "Shop Floor" tab (v1 `shop-board.html` deleted 2026-09-17).
- Related docs: `ro-checkin-tech.md` (tech assignment + the `shopboard_pickup` no-`status`
  quirk), `floor-tags.md` (floor tags & lanes).

## Session change log
- 2026-09-19 — Prod ghost cleanup done: this board's source went from 30 floor cars to 16 (the 14
  closed-RO ghosts removed; 13 open + 2 declined + #6074 remain). [[ro-checkin-tech]] change log.
- 2026-09-19 — §8 added: the "jobs that already left" ghosts — cause (only Off lot cleared the floor;
  Stage-dropdown closes didn't) and the write-side fix + one-time cleanup. No change to this board's
  code. Branch `fix/close-clears-floor`, unmerged. Verified on `test.*` at `993b51e`: after the
  sandbox cleanup + three test closes (Stage dropdown ×2 incl. a lift, Off lot ×1) this board showed
  11 cars and none of the 6 removed; the Approval Queue and MG Tech Status matched
  ([[ro-checkin-tech]] change log has the detail).
- 2026-09-19 — §4: noted the RO now has its own, separate `repair_orders.job_category`
  ([[ro-checkin-tech]] §7), never mirrored to the floor row this board reads. No code change here.
  Shipped to prod at `de37577`.
- 2026-09-17 — v1 `shop-board.html` deleted; dropped it from the manager floor-editor references
  (§4, §7, gaps, "Where it lives"). Rest not re-verified.
- 2026-08-21 — **Columns now key off assignment, not role (§2a).** Jobs assigned to a name
  outside `role='tech'` had no column while still counting as Assigned — the counter and the
  columns disagreed and the work showed nowhere. Undeferred from the "no phantom columns"
  decision. No schema change; no new UI (initials fallback already existed).
- 2026-07-30 — Created during Kevin's "let the manager edit from the tech board" request.
  Documented the dispatcher's read model, the derived-status state machine, the drag-assign
  write, the My Numbers relationship, and the absence of a viewer role; laid out fix options.
  **Investigation only — no app code changed.**
