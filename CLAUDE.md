# CrisData — CC project instructions

## Deploying — PUSH, never CLI (READ THIS)

**You deploy by pushing to a branch. Never run `vercel` to deploy.**

| Push to | Builds | Serves |
|---|---|---|
| `main` | **production** | `leetransmissionshop.com`, `www`, `board.*` |
| `staging` | preview bound to `gitBranch: staging` | `test.leetransmissionshop.com` |
| any other branch | preview | its own `shop-board-git-<branch>-…` alias |

Both are automatic and both are live (verified 2026-08-19).

**Prod code = `368d5e5`** (2026-09-18, 19:26 ET — RO-totals load-order fix; www/board/apex
`/api/version` verified). Any later commit on `main` up to the one that wrote this line is
docs-only. Update this line on every code ship.

1. **Anything pushed to `main` goes live.** There is no "push now, ship later". If work must not
   ship yet, it goes on a **feature branch** — do not push it to `main` and plan to hold it.
2. **After a push, wait for the build before checking `/api/version`.** Checking immediately
   returns the **previous** SHA and reads exactly like "the deploy didn't happen". Give it
   ~30–60s, or watch `vercel ls shop-board --prod` for a `● Ready` row newer than the push.
3. **If a push doesn't deploy, fix the integration — don't route around it with the CLI.**
4. **A `● Ready` production row is not a ship — only `/api/version` on `www` is.** On 2026-09-18,
   during a Vercel build incident, a `main` push lagged ~30 min (lagged, **not** skipped — check
   vercel-status.com before retrying; don't stack retry pushes), and a Ready production build was
   not followed by the domains until Cris clicked **Promote** in the dashboard. That stall was
   the incident: once it cleared, the next production build took the domains on its own (the
   project's `live: false` flag does **not** block that). See [[hosting-domains]] §3.6.

**Why the CLI is banned** (both diagnosed 2026-08-19 — see [[hosting-domains]] §3.6):
- `vercel --prod` uploads the **working directory**, not the git tree. Untracked files not named
  in `.vercelignore` ship to a public origin — that is exactly how session handoff notes, a
  business-model doc, `setup_shopboard.sql` and `.claude/` became publicly readable on prod.
- It stamps `/api/version` from whatever local HEAD happens to be, so the version an installed
  PWA sees may match no reviewed commit — and a deploy from a dirty tree would stamp a lie.

## File Cabinet — living wiring docs (READ THIS)

CrisData keeps **one living doc per subsystem** under `/docs/wiring/`. These are the
source of truth for *how the system is wired right now* — **not** changelogs. The
owner board renders them as the **File Cabinet**. Keeping them honest is part of your
definition of done, not an optional extra.

### The three rules

**1. Read before you change.**
Before editing a subsystem, open its wiring doc first and work from it. If the code
contradicts the doc, the code wins — fix the doc as part of your change (rule 2).

**2. Update in place, in the same commit.**
Any change that alters how a subsystem works must update the matching
`/docs/wiring/*.md` **in the same commit that changes the code**. Rewrite the
"how it works" sections to match reality — do **not** append a dated note and leave
the old text standing. Verify every claim against the actual code / schema / migration
before you write it; never carry forward a line you haven't re-checked this session.
If a subsystem you changed has no doc yet, create one from the template below.

**3. End-of-session cabinet pass.**
Before wrapping, for each subsystem touched this session: confirm its doc matches the
code, set the header's date + `verified vs commit <HEAD>`, add one line to that doc's
Session change log, and mark any doc made stale by today's work as `⚠ Needs review`
(don't guess-update it). Report a one-line list: docs updated, docs flagged.

### Never
- Never let "durable in the DB but not documented" count as done — same spirit as
  "not re-displayed isn't shipped."
- Never write a wiring claim you haven't verified against the real code this session.
  A tidy, confident, wrong doc is worse than no doc.

### Doc template
Every file under `/docs/wiring/` follows this shape:

```
# How <subsystem> is wired
<meta: doc path · last-updated date · verified vs commit <hash> · review status>

## 0. In one line — plain-language: what this subsystem is.
## 1..N. How it works — numbered sections BY CONCEPT, not by date.
## Known gaps & open questions (as of <date>)
## Where it lives in the code — the actual files, endpoints, migrations.
## Session change log — dated one-liners. The ONLY dated part.
```

### Subsystem → doc → code map (keep this current too)

| Subsystem | Doc | Main code |
|---|---|---|
| Comeback / warranty (incl. the RO detail's Warranty toggle + Status dropdown refresh) | `comeback-warranty.md` (§6 = when the toggle re-reads the floor row; the live floor channel is parked) | `advisor-board.html` (`refreshFloorControls`, `populateWarrantyToggle`/`populateStatusFloor`), `shared/comeback-chain.js`, `shared/warranty-mirror.js`, `shared/floor-refresh-gate.js` (+`.test.js`) |
| Recordings / audio | `recordings-audio.md` | `api/recording-links.js`, `shared/recording-player.js`, `api/recording-assign.js` |
| Customer record (incl. Edit + duplicate-phone warning) | `customer-record.md` (§4c/§4e = the list cache's two honesty rules; §4f = Edit) | `#view-customer` + `#custEditModal` in `advisor-board.html`, `shared/customer-edit.js` (+`.test.js`), `shared/cust-cache-guard.test.js` |
| NEW badge (the expiring "NEW" pill for fresh features) | `new-badge.md` (§1 = how to add one) | `shared/new-badge.js` (+`.css`, +`.test.js`), loaded by `advisor-board.html` |
| RO vehicle box (Vehicle & reference details · Transmission) | `ro-vehicle-details.md` | `advisor-board.html` (`updateVehicleField`, `decodeRoVin`, `#cdRoTrans`), `vehicles.transmission_code`, `shared/vin-decode.js` |
| Intake wizard | `intake-wizard.md` | `advisor-board.html` |
| Floor tags & lanes | `floor-tags.md` | `advisor-board.html` |
| Call window & Desk | `call-window-desk.md` | `advisor-board.html` (`callerCard` + `desk` IIFEs) |
| Call auto-attach (Phase 2) | `call-auto-attach.md` | `shared/call-auto-attach.js`, `api/ctm-webhook.js` (`autoAttachCall`), `advisor-board.html` (`autoFileRoForCall`), `migrations/20260818_call_auto_attach.sql`, `migrations/20260818_customers_phone_l10.sql` |
| Announcement banner | `announcements.md` (§5 = the employees-only gate) | `shared/announcement-banner.js`, `api/announcement.js` (+ `api/_lib/require-user.js`, `shared/auth-fetch.js`), advisor + owner boards |
| To-Do list | `todo-list.md` | To-Do JS duplicated in all 4 office boards; `shared/board-shell.css` |
| RO check-in / tech assign | `ro-checkin-tech.md` | `advisor-board.html` (`checkInArrived`, `assignTechCore`), `crisdata-techboard.html`, `shared/status-mirror.js` |
| Tech Board (dispatcher) | `tech-board.md` (§2a = columns key off assignment) | `crisdata-techboard.html`, `my-numbers.html`, gm-board Shop Floor · Tech Status · Teardown, `shared/assignee-picker.js` |
| Manager board Technicians (Billed Hrs) | `manager-board.md` | `gm-board.html` (`renderTechnicians`, `computeBilledHours`); `repair_orders`, `ro_line_items` |
| Manager board Overview cards (card library · per-employee layout · `status: retired`) | `gm-overview-cards.md` (§2 = the three `status` values; §4 = why the `completed_jobs` group is retired) | `gm-board.html` (`CARD_LIBRARY`, `mergeOverviewLayout`, `renderOverviewSkeleton`, `renderCustomizeList`), `dashboard_preferences` |
| My Numbers (tech phone tool) | `my-numbers.md` (§1 = PIN checked by `login_with_pin`, never in the browser) | `my-numbers.html`, `shared/pin-login.js` (+`.test.js`); consumers: `advisor-board.html`, `gm-board.html` |
| Book-hours (tech pay) / flagged-hours | `flat-rate-hours.md` | `repair_orders.book_hours`, `shopboard_*.flag_hours`, `ro_line_items`, `completed_jobs`, `repair_orders.technician` |
| Advisor Commission (GP rollup + payout) | `advisor-commission.md` | `shared/commission-engine.js`, `shared/commission-cards.js`; `repair_orders.service_writer_id`, `ro_line_items`, `package_units`, `employees`; advisor/owner/bookkeeping boards |
| Packages (unit prices + Package line) | `packages.md` | `package_units`, `ro_line_items.package_unit_id`/`rr_hours`, `shop_settings.feature_packages`, `shared/board-settings.js`, `advisor-board.html` |
| Cost & Profit (Build Sheet) | `cost-profit.md` | `shared/build-sheet.js` (cost layer + parts library + vendor sweep + People & rates), `shared/board-settings.js` (`renderUnitsEditor`+`costLayer`/`wireCostRow`/`renderRebuildUnits`), `unit_parts` (+`library_part_id`), `parts_library`, `package_units.unit_cost` (confirmed cost), `shop_settings.std_rr_rate`/`rebuilder_cost`/`std_advisor_pct`, `owner-board.html`, `bookkeeping-board.html` (no feature switch) |
| Profit by RO (per-job profit) | `profit-by-ro.md` | `shared/profit-by-ro.js`, `shared/period-range.js` (shared window math, also used by Financial Pulse), `shared/commission-engine.js` (`roGrossProfit`), `repair_orders.closed_at`, `ro_line_items`, `package_units.unit_cost`; `owner-board.html`, `bookkeeping-board.html` |
| RO line items (Add/Edit-Line pop-up · strict number fields) | `ro-line-items.md` (§2a = why every number is `type="text"`, never `type="number"`) | `ro_line_items` (+ `unit_cost`), `advisor-board.html` (`#cdLineModal`, `renderLines`, `openLineModal`/`saveLineModal`, `lfNum`/`wireLineNumbers`/`lfRead`), `shared/line-qty.js` (+`.test.js`) |
| Invoice capture & classify (Process-Invoice modal · preview zoom) | `invoice-classify.md` (**§4a rotate WRITES to storage · §4b zoom is view-only CSS transform**; §5 = rotate × zoom compose) | `advisor-board.html` (`#view-capture`), `bookkeeping-board.html` (`#invoiceDetailModal`, `rotateInvoiceImage`, `invZoom*`), `api/extract-invoice.js` (+ `api/_lib/require-user.js` — employees-only gate), `invoice_queue` |
| Financial Pulse (bookkeeping) | `financial-pulse.md` | `bookkeeping-board.html` (`#finPulse`, `FinancialPulse`); `invoice_queue`, `repair_orders` + `ro_line_items`, `completed_jobs` |
| RO / invoice document (print + embed) | `ro-invoice.md` (**§4 = the three consumers; the builder is the ONLY copy of the document AND of `DOC_LABEL`**) | `shared/ro-invoice.js`; `advisor-board.html` (`printRo` wrapper), `bookkeeping-board.html` (RO-detail left pane + `printRoDetail` / `#finRoPrint`) |
| Card fee (live per-RO switch) + THE RO total calculator | `card-fee.md` (§3 = the 9 places an RO is totalled — all via `shared/ro-totals.js`; **§3a = no total renders before the calculator loads**; §5 = the two-step migration) | `shared/ro-totals.js` (+`.test.js`), `shared/ro-totals-ready.js` (+`.test.js`), `repair_orders.card_fee_on`, `shop_settings.card_fee_pct`, `advisor-board.html` (`roTotalsOf`, `#cdCardFeeOn`), `bookkeeping-board.html`, `shared/ro-invoice.js`, `shared/customer-record.js`, `shared/profit-by-ro.js`, `migrations/20260918_ro_card_fee_on_{SANDBOX,PROD}.sql` |
| RO payments ledger | `payments.md` | `ro_payments`; `advisor-board.html` (`recordPayment`/balance), `bookkeeping-board.html` (income + RO detail) |
| Settings hub | `settings.md` | `shared/board-settings.js`, `shop_settings`, `employees`, `crisdata.html`, `api/announcement.js` |
| File Cabinet tab | `file-cabinet.md` | `shared/file-cabinet.js`, `owner-board.html` |
| RO photos **and video** (**per-RO** buckets · capture · move · archive · lightbox) | `ro-photos.md` (§1a = a bucket belongs to ONE RO; §1c = born-with-buckets trigger; **§1d = why a video is a `ro_photo` row and NOT an `ro_video` enum value — read before touching `kind`**; §1e = no media element in any grid; §5f = the list+index lightbox) | `photo_buckets` (`ro_id` NOT NULL, `archived_by`), `photo_bucket_templates`, `trg_repair_orders_photo_buckets`, `attachments` (`ro_photo`, `bucket_id`, `uploaded_by`, `deleted_at`), `shared/photo-buckets.js` (+`.test.js`), `shared/ro-media.js` (+`.test.js`), `shared/photo-compress.js`, `my-numbers.html`, `advisor-board.html` (`#view-customer` + RO detail) |
| Tech findings (diagnosis handoff · append-not-overwrite) | `tech-findings.md` (§2a = why the `␞` delimiter can't collide; §3b = the Edit lock) | `shared/tech-findings.js` (+`.test.js`), `my-numbers.html` (`submitDiagnosis`, `roFindingsHtml`), `advisor-board.html` (`renderRoFindings`, `loadRoFindings`, the queue card's `tfNewest`), `repair_orders.diagnosis_recommendation`/`_submitted_at`/`_reviewed_at`, `ro_diagnostic_codes` |
| Page map (pages · routing · legacy doors) | `page-map.md` | `crisdata.html` (`ROLE_DEST`), `vercel.json`, the 9 root `*.html`, `shared/office-identity.js`, `shared/supabase-config.js` |
| Hosting & domains | `hosting-domains.md` | `vercel.json`, `api/send-push.js`, Vercel projects (shop-board/kiki), Namecheap DNS, Supabase `hygemiszxwmyrkmhbjub` |
| Employee roster (hire · retire · test accounts · assignment-vs-role) | `employee-roster.md` (§7a = the assignee write-safety rule) | `employees` + `employees_visible` (`is_test`), `employee_secrets` + `login_with_pin` (§1c — PIN hashes, no API access; `migrations/20260917_pin_off_public_*`, applied to both projects 2026-09-17), `shared/assignee-picker.js` (+`.test.js`), `shared/office-identity.js`, `my-numbers.html` (login), `gm-board.html` (employee CRUD), the 19 roster readers |
| Staging database (isolated test.* DB) · **env guard `app_env`** | `staging-db.md` (§8 = which DB am I on) | `shared/supabase-config.js` (hostname→creds switch), `api/*` (`SUPABASE_URL`/`_ANON_KEY` env-with-prod-fallback), `staging/staging-schema.sql`, `public.app_env`, the 12 boards |
| Meta / Facebook webhook (receive + verify) | `meta-webhook.md` (**§4 = the signature is ENFORCED here, unlike ctm-webhook — do not align the two files**) | `api/meta-webhook.js` (+`.test.js`); env `META_APP_SECRET`, `META_VERIFY_TOKEN`; no DB, no UI |
