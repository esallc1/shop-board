# How the "Report a Change" intake is wired

> Doc: `/docs/wiring/change-requests.md`
> Last updated: 2026-07-31 — verified vs commit `86023fa`
> Status: ✅ Phase 1 (submit + triage) BUILT — verified vs commit `86023fa`,
> against `migrations/20260731_change_requests.sql`, `api/change-request.js`
> (+ `.test.js`), `shared/report-change.js`, and the four boards. **The migration is
> not auto-run — Cris applies it by hand; until then the triage panel shows "Run the
> migration" and submitting fails with a hint.** §7 (My requests loop-back) and §8
> (screenshot annotation) are NOT built — Phase 2 / 3.

## 0. In one line
The **inbound counterpart to the announcement banner**: Kevin (Manager), Josh (Advisor)
and Bookkeeping submit a **Bug / Idea** — text and/or an uploaded screenshot — from a
**🚩 Report a change** button on their own board; the owner **triages** it (New → Reviewing
→ In progress → Done / Not now / Won't build) from the owner board's **Team Comms** tab and
writes a neutral status note back. It replaces the change requests that used to arrive by
text and get lost.

---

# PART A — How Phase 1 works (BUILT)

## 1. Data — the `change_requests` table
One row per submission. **RLS anon-SELECT only; all writes are service-role** (same posture
as [[announcements]] / `calls`) — the boards read the list/triage with the anon key but can
**never** insert or update it; that goes through `api/change-request.js`. **We did not widen
anon writes.**
- Content: `type` (`bug|idea`, CHECK), `priority` (`immediate|high|normal|low`, CHECK,
  default `normal` — the To-Do scale), `body` (nullable note),
  `screenshot_path/screenshot_name/screenshot_mime` (nullable pointer into the
  `crisdata-attachments` bucket under `reports/<uuid>/…`).
- Submitter (a hint, not a boundary — §5): `submitted_by_id` (uuid → `employees.id`, nullable),
  `submitted_by_name`, `submitted_by_role`.
- Silent context: `context_board` (`manager|advisor|bookkeeping`), `context_view` (the active
  tab), `context_ro` (nullable), `app_version` (build SHA), `user_agent`.
- Triage: `status` (`new|reviewing|in_progress|done|not_now|wont_build`, CHECK, default `new`),
  `owner_note` + `owner_note_at` (the latest neutral note back — denormalized; surfaced on the
  submitter's board in Phase 2), `created_at`.
- **A submission must carry SOMETHING:** the `change_requests_has_content` CHECK requires a
  non-blank `body` OR a `screenshot_path` (mirrors the endpoint's "note or screenshot" rule).
- Indexes on `status`, `created_at desc`, `submitted_by_id`; added to `supabase_realtime` so
  the triage panel updates live.
- **No `archived_at` / `updated_at` in Phase 1** — deliberately minimal; a request isn't
  retired, just moved to a terminal status.
- Migration: `migrations/20260731_change_requests.sql` (hand-run). **No storage migration** —
  the `crisdata-attachments` bucket already has bucket-wide anon insert/read
  (`20260716_ro_foundation.sql:452-465`), so `reports/<uuid>/…` needs no new policy.

## 2. The endpoint — `api/change-request.js` (service-role)
Mirrors `api/announcement.js`: a pure, exported, **test-locked** `parseChangeRequestBody`
(11 cases in `api/change-request.test.js`) + a service-role PostgREST write. Two actions:
- **`create`** (submit): validates `type`, coerces `priority` (unknown → `normal`), trims
  `body` (≤5000), and requires **body OR screenshot**. `status` is **server-set to `new`**
  (never taken from the body). A non-uuid `submitted_by_id` is dropped to null. Inserts, returns
  `{ request }`.
- **`triage`** (owner): validates `id` (uuid) + `status` (whitelist); if `owner_note` is present
  (≤2000, trimmed) it also stamps `owner_note` + `owner_note_at`. PATCHes, returns `{ request }`.
- **Screenshot-path guard:** a posted `screenshot_path` must match `reports/<uuid>/<file>` —
  a caller can't point a row at an arbitrary object elsewhere in the bucket.
- **Prod-only** (needs `SUPABASE_SERVICE_ROLE_KEY` on Vercel), same as the announcement endpoint.
- **Honest security note:** the endpoint blocks anon table writes and validates input; it does
  **not** verify WHO calls it (no server-verifiable identity yet — §5). "Only the owner triages"
  is a cosmetic client gate today, same posture as announcements. It tightens for free once the
  [[settings]] §6 auth token lands.

## 3. The module — `shared/report-change.js` (two roles, one IIFE)
`window.ReportChange.init(config)`, self-injecting (`.rc-*` styles), same two-role shape as
`shared/announcement-banner.js`. `init` picks a role from the config: **`board` → submit**,
**`triageMount` → triage** (a board passes one).
- **Submit role.** Self-mounts a **🚩 "Report a change" button into `.view-topbar`**
  (`margin-left:auto`, right-aligned — deliberately NOT a second FAB alongside CatchMoment). It
  opens a modal: **Bug/Idea** toggle · **priority** select (the To-Do scale) · a note textarea ·
  an **optional screenshot upload** (`image/*`, ≤15 MB, with a preview + remove). On Send it
  **uploads the screenshot FIRST** to `reports/<uuid>/screenshot.<ext>` with the anon key
  (a failed upload never leaves a dangling pointer), captures context — active
  `.sidebar-item.active[data-view]`, `/api/version` (fetched once, cached), `navigator.userAgent`,
  and the `board`/identity getters — then POSTs `create`. Requires a note or a screenshot.
- **Triage role.** Renders a **"Requests & Feedback" `.card`** into its mount. Each row shows a
  type chip (🐞 Bug / 💡 Idea), a **priority pill reusing the To-Do `.todo-prio-tag-*` classes**,
  submitter + role + relative time, the note (or "screenshot only"), the **screenshot** (lazy
  `createSignedUrl`, 1 h), and an **auto-context box** (board · view · RO · build · user-agent).
  A **status `<select>`** drives `triage`, and a **"Send update to <submitter>"** textarea writes
  `owner_note` (neutral-wording placeholder — explicitly not a promise). Filters: status
  (Open / All / each status) and sort (Priority / Newest). It owns its **own realtime channel +
  self-heal** (`resubscribe` / `ensureHealth` on focus / visibilitychange / 60s tick), so it
  needs no `VIEW_REFRESH` registration — the same encapsulated pattern as the announcement banner.
- **Graceful pre-migration:** a missing table (42P01) → the triage panel shows "Run the
  change_requests migration to enable this."; submit surfaces a "(has the migration been run?)"
  hint on a bucket/insert failure.

## 4. Where it's wired (the four boards)
- **Submit — 3 office boards.** Each adds `<script src="shared/report-change.js">` after the
  announcement banner and one `ReportChange.init({ db, endpoint:'/api/change-request', board,
  getName, getRole, getEmployeeId })`:
  `advisor-board.html` (`board:'advisor'`), `gm-board.html` (`board:'manager'`),
  `bookkeeping-board.html` (`board:'bookkeeping'`). The identity getters are **lazy** (called at
  Send, after `captureSessionAndGreet()` / `gateAndBoot()` resolves), the same pattern as the
  existing `CatchMoment.init`.
- **Triage — owner board.** `owner-board.html` adds the script + a `#requests-triage` mount
  **above** the "Post an announcement" card inside `#view-announce`, and
  `ReportChange.init({ …, triageMount:'#requests-triage', getName })`. The sidebar item + topbar
  for that tab were **renamed "Announcement" → "Team Comms"** (the `data-view="announce"` /
  `#view-announce` id is unchanged, so the rest of the announcement wiring is untouched).
- **File Cabinet:** this doc is registered in the `DOCS` manifest (`shared/file-cabinet.js`) and
  the README index so it renders in the cabinet.

## 5. Identity is a UX hint, not a boundary ([[settings]] §3)
After the PIN login a board persists only the phone — no token, no Supabase Auth session; every
DB call uses the public anon key. So:
- **Submitter role is inferred from which board sent it** (`getRole()` falls back to `board`).
  Good enough for a trusted 3-person team; spoofable in principle, like everything today.
- **Triage is not truly owner-only yet** — it's protected by "anon can't write the table" + a
  cosmetic client gate. It becomes a real boundary once the [[settings]] §6 auth token lands.
  **This feature did not block on auth.**
- **The triage/list is a client-side view over anon SELECT** (all rows are readable, like
  `announcements`). Fine here; becomes an RLS boundary after auth. This is also why "My requests"
  (Phase 2) is a client-side filter by `submitted_by_id`, not a security scope.

## 6. Storage & priority reuse (verified)
- Screenshots reuse the **existing private `crisdata-attachments` bucket** under
  `reports/<uuid>/…` (anon upload, short-lived signed-URL read) — the same trust boundary as
  invoice images and chat/todo attachments. **A board screenshot may contain customer PII**;
  accepted for this team, revisited when Supabase Auth lands (a "tighter" bucket is still
  anon-read without a token).
- Priority reuses the To-Do scale + colors verbatim ([[todo-list]] §3): the triage pills are the
  shared `.todo-prio-tag-*` classes; the row's left border is `.rc-item.prio-*` (same
  immediate=red / high=amber / normal=neutral / low=muted mapping).

---

# PART B — NOT built yet (Phase 2 / 3)

## 7. Phase 2 — "My requests" loop-back
Surface each submitter's own rows (status + latest `owner_note`) back on their board, so they
see where a request landed without a text. A client-side filter by `submitted_by_id` over the
same anon SELECT; realtime. `owner_note` is already being written in Phase 1, so this is
read-side only. (Add a `change_request_updates` thread table only if a history is wanted — the
denormalized `owner_note` covers the single-latest note.)

## 8. Phase 3 — screenshot capture + annotation
One-click in-browser screenshot (`html2canvas`) + arrow/text-bubble markup (`marker.js`),
flattened to a PNG, replacing/augmenting the upload. **New dependency — none exists in the app
today; must be vendored locally** (no-CDN-for-logic convention). Heaviest lift, deliberately last.
Prototype reference: `crisdata-annotate-report.html` (not in the repo).

## Known gaps & open questions (as of 2026-07-31)
- **Migration pending** — `20260731_change_requests.sql` must be hand-run in Supabase before the
  feature is live; the UI degrades gracefully until then.
- **Owner-only triage is cosmetic** until the [[settings]] §6 auth token (§5). Not a blocker.
- **`crisdata-attachments` is anon-read** — screenshots (possible PII) are readable with a signed
  URL by anyone with the path; same boundary as existing attachments.
- The stale "advisor + owner boards" helper copy on the announcement panel
  (`owner-board.html`) was left as-is (out of Phase 1 scope) — the banner actually shows on
  advisor + manager + bookkeeping.

## Where it lives in the code
- Module: `shared/report-change.js` — `window.ReportChange.init({ db, endpoint, board?, getName,
  getRole?, getEmployeeId?, getRo?, triageMount? })`; submit button+modal, triage card, realtime
  self-heal, injected `.rc-*` CSS.
- Endpoint: `api/change-request.js` (+ `api/change-request.test.js`, 11 cases).
- Schema: `migrations/20260731_change_requests.sql` (hand-run; no storage migration).
- Hosts (submit): `advisor-board.html`, `gm-board.html`, `bookkeeping-board.html` — script +
  `ReportChange.init({ board })`. Host (triage): `owner-board.html` — `#requests-triage` in
  `#view-announce` (the "Team Comms" tab) + `ReportChange.init({ triageMount })`.
- Manifest: `shared/file-cabinet.js` DOCS row + `docs/wiring/README.md` index.
- Patterns mirrored: [[announcements]] (endpoint + two-role module + realtime self-heal),
  `api/desk-appointment.js` ("one of N" validation), `shared/catch-moment.js` +
  `20260721_todo_attachments.sql` (anon upload → `file_path` on the row → signed-URL read).
  Related: [[todo-list]], [[settings]], [[file-cabinet]].

## Session change log
- 2026-07-31 — Created during the "Requests & Feedback intake" investigation (proposal only).
- 2026-07-31 — **Built Phase 1** (submit + triage): the `change_requests` table
  (anon-SELECT; service-role writes; content CHECK; realtime), `api/change-request.js`
  create/triage with a test-locked validator, and `shared/report-change.js` (submit button+modal
  on the 3 office boards + the Requests & Feedback triage card on the owner board, with realtime
  self-heal and signed-URL screenshots). Renamed the owner "Announcement" tab to **Team Comms**
  and slotted the triage card above "Post an announcement". Screenshots reuse
  `crisdata-attachments` under `reports/<uuid>/…` (no storage migration). Registered this doc in
  the File Cabinet. **Migration handed to Cris to run by hand; not yet applied.** Phase 2
  (My requests loop-back) and Phase 3 (annotation) not built.
