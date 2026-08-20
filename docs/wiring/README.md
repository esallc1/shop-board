# /docs/wiring — the File Cabinet

One **living doc per subsystem**: how CrisData is wired *right now*, not a changelog.
The owner board renders this folder as the **File Cabinet**.

Rules for keeping these honest live in the project `CLAUDE.md` (read-before,
update-in-place-in-the-same-commit, end-of-session cabinet pass). The short version:
**if you change how a subsystem works, rewrite its doc in the same commit — and verify
every claim against the real code before writing it.**

## ⚠️ Recurring hazard — the 1,000-row API cap

**PostgREST silently truncates an unbounded `select()` at 1,000 rows.** No error, no warning —
just fewer rows than you asked for. Any code that reads a whole table and filters the result in
JavaScript is wrong the moment that table passes 1,000.

This has bitten us for real. `lookupPhone` in the intake wizard did an unbounded
`db.from('customers').select(...)` against a 2,717-row table, so **1,700 customers (62.6%) could
not be found by phone** and the advisor was walked into creating a duplicate — on every intake,
every day. `JOSE RAMIREZ` is literally the last row in the table and did not resolve. Fixed
2026-08-18 ([[intake-wizard]] §4).

**The rule:** a read that drives a **MATCH or a SEARCH** must never be an unbounded select.
A truncated display list is ugly; a truncated match **invents a duplicate**.

Three acceptable shapes, in order of preference:
1. **Filter server-side** — `.eq()` / `.in()` / `.or(...ilike...)`. Best: the DB does the work
   and the payload stays small as the shop grows.
2. **Page it** — `.range(from, from + 999)` in a loop, like `window.cdFetchAllCustomers`
   (`advisor-board.html`). Use when you genuinely need every row (the A–Z browse does).
3. **Bound it explicitly** — `.limit(n)` where a cap is the intended behaviour, so the
   truncation is a decision rather than an accident.

Tables already over the cap: **`vehicles` (3,251)**, **`customers` (2,717)**. Growing toward it:
`calls`, `invoice_queue`, `recordings`, `repair_orders`, `completed_jobs`.

An audit of every unbounded read is in [[intake-wizard]] §5.

## Index

| Subsystem | Doc | Status |
|---|---|---|
| Comeback / warranty | [comeback-warranty.md](comeback-warranty.md) | ✅ verified vs `bea25cf` |
| Recordings / audio | [recordings-audio.md](recordings-audio.md) | ✅ verified vs `bea25cf` |
| Customer record | [customer-record.md](customer-record.md) | ✅ verified vs `bea25cf` |
| Customer duplicates & multi-phone | [customer-dedupe.md](customer-dedupe.md) | ⚠ investigation + design vs `c2a180d` (not built) |
| Intake wizard | [intake-wizard.md](intake-wizard.md) | ✅ verified vs `7652c65` · incl. §3 vehicle dup guard, §4 the phone-lookup row-cap fix, §5 the full unbounded-read audit |
| Floor tags & lanes | [floor-tags.md](floor-tags.md) | ✅ verified vs `bea25cf` (partial — full lane taxonomy still thin) |
| Call window & Desk | [call-window-desk.md](call-window-desk.md) | ✅ verified vs the commit that adds it |
| Announcement banner | [announcements.md](announcements.md) | ✅ verified vs the commit that adds it |
| RO check-in / tech assign | [ro-checkin-tech.md](ro-checkin-tech.md) | ✅ verified vs `832077d` (documents a live bug) |
| Tech Board (dispatcher) | [tech-board.md](tech-board.md) | ✅ verified vs `8ec2164` (investigation) |
| My Numbers (tech phone tool) | [my-numbers.md](my-numbers.md) | ✅ verified vs `be6cef7` (investigation) |
| Flagged-hours / flat-rate data | [flat-rate-hours.md](flat-rate-hours.md) | ✅ verified vs `22e3a5a` (investigation — data not yet buildable) |
| Financial Pulse (bookkeeping Overview) | [financial-pulse.md](financial-pulse.md) | ✅ verified vs `0168264` · incl. §8 Clover-vs-board reconciliation model (example 2026-08-06) |
| Settings hub (storage · roles · enforcement) | [settings.md](settings.md) | ✅ verified vs `0663cbd` (investigation + proposal — not built) |
| Office auth (Supabase Auth adoption) | [office-auth.md](office-auth.md) | ⚠ investigation + plan vs `77bf5c5` (not built) |
| To-Do list | [todo-list.md](todo-list.md) | ✅ verified vs the commit that adds it |
| Requests & Feedback intake | [change-requests.md](change-requests.md) | ✅ Phase 1 + 2 + 3 built vs `4bf7eb0` (live) |
| File Cabinet (this tab) | [file-cabinet.md](file-cabinet.md) | ✅ verified vs the commit that adds it |
| Advisor commission (GP rollup + payout) | [advisor-commission.md](advisor-commission.md) | ✅ BUILT vs `8c93cee`, behind an owner switch |
| Call auto-attach (Phase 2) | [call-auto-attach.md](call-auto-attach.md) | 🟡 live code + both manual re-file controls built and exercised in-browser |
| Cost & Profit (Build Sheet) | [cost-profit.md](cost-profit.md) | ✅ Step 1 + Step 2a built vs branch `profit-by-ro` |
| Hosting & domains (Vercel · DNS · Supabase) | [hosting-domains.md](hosting-domains.md) | ✅ verified vs `c17db7e` — §3.5 + §5 corrected for the sandbox split (2026-08-19) |
| Manager board Technicians (Billed Hrs) | [manager-board.md](manager-board.md) | ✅ BUILT + verified live vs `8c93cee` |
| Packages (unit prices + Package line) | [packages.md](packages.md) | ✅ BUILT vs `17d4b02`, behind `feature_packages` (default OFF) |
| RO payments ledger | [payments.md](payments.md) | ✅ verified vs `455693f` |
| Profit by RO (per-job profit) | [profit-by-ro.md](profit-by-ro.md) | ✅ Steps A + B + C built vs branch `profit-by-ro` |
| RO / invoice document (print + embed) | [ro-invoice.md](ro-invoice.md) | ✅ BUILT + verified vs `455693f` |
| RO line items (Add/Edit-Line pop-up) | [ro-line-items.md](ro-line-items.md) | ✅ BUILT + verified live vs `17d4b02` |
| Staging database (isolated `test.*` DB) | [staging-db.md](staging-db.md) | ⚠ **Needs review** — header still reads 🟡 in-progress (2026-08-12), but the sandbox is live and prod-deployed |
| RO photos (buckets · capture · archive) | [ro-photos.md](ro-photos.md) | 🟡 slice 1 live on staging, slice 2 built + unmerged; **carries a live FINDING in §6** |
| Page map (which pages exist, who reaches them) | [page-map.md](page-map.md) | ✅ verified vs `c17db7e` — replaces the flat 12-name handoff list |

_Seeded 2026-07-30 from the Jul 29 session handoff. Verified 2026-07-30 against commit `bea25cf`:
every claim re-checked against source; two docs remain partial (noted above) but contain no
unverified claims._

_Index reconciled 2026-08-19 against commit `c17db7e`: the folder held **11 docs the index never
listed** (advisor-commission, call-auto-attach, cost-profit, hosting-domains, manager-board,
packages, payments, profit-by-ro, ro-invoice, ro-line-items, staging-db) — all added above, each
row taken from that doc's own header rather than re-derived. `page-map.md` added the same day.
**The index is not self-maintaining:** a new doc must be added here **and** to the `DOCS` manifest
in `shared/file-cabinet.js`, which is a hardcoded list (a static deploy cannot enumerate a
directory) — a doc missing from that manifest exists on disk but never renders in the tab._
