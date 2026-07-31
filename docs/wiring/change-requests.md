# How the "Report a Change" intake is wired

> Doc: `/docs/wiring/change-requests.md`
> Last updated: 2026-07-31 — verified vs commit `4bf7eb0`
> Status: ✅ ALL THREE PHASES BUILT — Phase 1 (submit + triage), Phase 2 ("My requests"
> loop-back), Phase 3 (capture + annotate, with the large "annotate mode" §8). Verified vs commit `4bf7eb0`, against
> `migrations/20260731_change_requests.sql`, `api/change-request.js` (+ `.test.js`),
> `shared/report-change.js`, `vendor/html2canvas.min.js`, and the four boards. **The
> migration is applied (feature live).**

## 0. In one line
The **inbound counterpart to the announcement banner**: Kevin (Manager), Josh (Advisor)
and Bookkeeping submit a **Bug / Idea** — text and/or an uploaded screenshot — from a
**🚩 Report a change** button on their own board; the owner **triages** it (New → Reviewing
→ In progress → Done / Not now / Won't build) from the owner board's **Team Comms** tab and
writes a neutral status note back. It replaces the change requests that used to arrive by
text and get lost.

---

# PART A — How it works (BUILT: Phase 1 + 2 + 3)

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
  opens a **two-tabbed** modal ("Report" | "My requests" — §7). The Report tab: **Bug/Idea**
  toggle · **priority** select (the To-Do scale) · a note textarea · an **optional screenshot**
  — either **📸 Grab my board** (capture) or **⬆ Upload a screenshot**, both feeding the same
  annotator (§8). On Send it **uploads the screenshot FIRST** to `reports/<uuid>/screenshot.<ext>`
  with the anon key (a failed upload never leaves a dangling pointer — if the user annotated, the
  flattened PNG is what's uploaded, §8), captures context — active `.sidebar-item.active[data-view]`,
  `/api/version` (fetched once, cached), `navigator.userAgent`, and the `board`/identity getters —
  then POSTs `create`.
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

## 7. "My requests" loop-back (Phase 2 — BUILT)
The submit role's modal has a second tab, **"My requests"**, showing the current user's own
submissions — a client-side filter `submitted_by_id = getEmployeeId()` over the same anon SELECT
(not a security scope, §5). Each row is **read-only**: type/priority chips, a **status pill**
(same labels/colors as triage), the note or "screenshot only", the screenshot (lazy signed URL),
and — when the owner has replied — an **"Update from the owner · <when>"** block with the
denormalized `owner_note`. It has its **own realtime channel** (`change-requests-mine`) plus the
same focus / visibilitychange / 60s self-heal, so a status move or a new note appears without a
reload.
- **Unread cue (per device).** A small red badge on the 🚩 button **and** the "My requests" tab
  counts the user's requests whose signature (`status::owner_note_at`) changed since they last
  opened the list — tracked in `localStorage` (`crisdata_seen_requests`), the same per-device
  posture as the announcement dismiss. A pristine `new`-with-no-note request never counts as
  unread (so your own just-sent request doesn't badge you). Opening "My requests" marks the shown
  rows seen and clears the badge; if there are unseen updates when you tap 🚩, the modal opens
  straight to "My requests".
- **Owner-note author label** is the literal "the owner" — `owner_note` has no author column
  (single-owner shop), so no name is stored or looked up.
- **No new table / migration / endpoint / board wiring.** Phase 2 lives entirely in
  `shared/report-change.js`, reusing the Phase 1 `getEmployeeId` getter the three office boards
  already pass. The triage side is unchanged. (A `change_request_updates` thread table is still
  only needed if a full history — beyond the single latest `owner_note` — is ever wanted.)

## 8. Screenshot capture + annotation (Phase 3 — BUILT)
The Report tab's screenshot step is now **capture-and-mark-up**, so submitters point at what they
mean. Two ways in, one annotator, flattened on submit — all in `shared/report-change.js`.
- **📸 Grab my board** — a one-click `html2canvas` capture of the current board. The modal hides
  itself (`visibility:hidden`) so it isn't in the shot, then captures the **visible viewport**
  (`x/y/width/height` = scroll + `innerWidth/innerHeight`) of `document.body`, `useCORS:true`,
  `scale = min(2, devicePixelRatio)`, with `ignoreElements` skipping the `.rc-overlay` /
  `.cm-overlay` modals. On any failure it says so and points at **⬆ Upload a screenshot**, which is
  the always-available fallback (`image/*`, ≤15 MB).
- **One annotator, either source.** `openAnnotator(src)` builds an image + an SVG overlay (red
  **arrows**, drawn on pointer drag; a drag under 14 px is a mis-click and discarded) + draggable
  **text-bubble notes** (contenteditable, drop with 💬 Note, drag by the header, ✕ to delete), with
  **Undo** (pops the creation stack) / **Clear** / **✕ Remove**. Bubbles are `pointer-events:none`
  while in arrow mode so a drag over one still draws.
- **Big "annotate mode" (the readability fix).** The instant there's an image on the Report tab,
  `applyAnnotateSize()` adds `.annotating` to expand the modal to **~92vw × 92vh (max-width 1180 px)**,
  collapse the type/priority/note into ONE compact strip, and make the stage the dominant element.
  `fitAnnoImage()` then sizes the image (measured, not %-based, so the stage shrink-wraps it and the
  flattened PNG stays tight): **desktop CONTAINS** the whole board (no scroll); **phone FILLS the
  width** and the stage scrolls. On a phone, **✋ Move** flips the stage `touch-action` to `pan-y` so a
  finger scrolls, while **Arrow/Note** keep `touch-action:none` to draw/place. Collapsing back
  (Remove / close / switch to My requests) returns the modal to its compact size.
- **Flatten on submit.** If the user drew anything, `flattenStage()` rasterizes the image + overlay
  to **one PNG** via `html2canvas` on the stage (`scale:2`), with a `.rc-flattening` class hiding the
  ✕/drag chrome so the PNG shows only the art. That PNG goes through the **unchanged Phase 1 upload**
  (`reports/<uuid>/screenshot.png` → signed-URL render in triage + My requests). **No annotations →
  the base image uploads untouched** (no needless re-encode). Flatten is **best-effort**: if
  `html2canvas` can't run, the un-annotated base image still uploads.
- **Annotation stays OPTIONAL** — text-only and plain-upload-without-markup both still work.
- **Vendored, no CDN.** `html2canvas` **1.4.1 (MIT)** is committed at `vendor/html2canvas.min.js`
  and **lazy-loaded** on first capture or first flatten (so no board pays for it on load; no board
  HTML references it). See `vendor/README.md`.
- **marker.js was NOT used** (the brief's suggested lib): marker.js **v2/v3 are commercially
  licensed** (paid EULA — not committable into a production repo), and v1 is MIT but
  old/unmaintained with its own toolbar. Per Cris's call, the annotator is a small **self-contained
  SVG layer** instead — zero third-party annotation dependency, matches the prototype
  (`crisdata-annotate-report.html`, not in the repo) exactly, and best fits the offline/PWA posture.

## Known gaps & open questions (as of 2026-07-31)
- **Migration applied** — `20260731_change_requests.sql` is run; the feature is live. (The UI
  still degrades gracefully with a "Run the migration" message if the table is ever absent.)
- **"My requests" unread is per device** — the seen-map is `localStorage`, so a user who switches
  devices sees the badge again there. Fine for the trusted team; a server-side read receipt would
  need the auth token (§5).
- **Owner-only triage is cosmetic** until the [[settings]] §6 auth token (§5). Not a blocker.
- **`crisdata-attachments` is anon-read** — screenshots (possible PII) are readable with a signed
  URL by anyone with the path; same boundary as existing attachments. **Grab-my-board captures the
  live board**, so a board showing customer names lands a PNG with those names in the bucket — same
  trust boundary, worth knowing.
- **html2canvas capture fidelity has known limits** — it re-renders the DOM from computed styles,
  so some effects (certain gradients/filters, cross-origin images without CORS, exotic CSS) can
  render off or blank. In testing the office boards captured faithfully (cards, banners, avatars,
  colors), but **⬆ Upload a screenshot is always the fallback** when a capture looks wrong.
- **Not exercised locally: the live capture→flatten→upload→triage round-trip.** The static preview
  has no `/api`, and a real submission would pollute the owner's prod queue, so verification covered
  capture + annotate + flatten-to-PNG (desktop + phone) and relied on the **unchanged, already-proven
  Phase 1/2 upload + signed-URL render** for the last hop. Worth a real end-to-end submit once
  deployed.
- The stale "advisor + owner boards" helper copy on the announcement panel
  (`owner-board.html`) was left as-is (out of scope) — the banner actually shows on
  advisor + manager + bookkeeping.

## Where it lives in the code
- Module: `shared/report-change.js` — `window.ReportChange.init({ db, endpoint, board?, getName,
  getRole?, getEmployeeId?, getRo?, triageMount? })`; submit button + two-tab modal
  (Report / My requests) with its own `change-requests-mine` realtime channel + the per-device
  unread badge (`crisdata_seen_requests`); the capture/annotate/flatten layer (`grabBoard`,
  `openAnnotator`, arrow/bubble handlers, `flattenStage`, `ensureHtml2Canvas`); triage card with
  the `change-requests-live` channel; injected `.rc-*` CSS.
- Vendored lib: `vendor/html2canvas.min.js` (1.4.1, MIT — lazy-loaded; see `vendor/README.md`).
  **No marker.js** (commercial; self-contained SVG annotator instead — §8).
- Endpoint: `api/change-request.js` (+ `api/change-request.test.js`, 11 cases).
- Schema: `migrations/20260731_change_requests.sql` (applied; no storage migration).
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
  the File Cabinet. **Migration handed to Cris to run by hand.** Phase 2 (My requests loop-back)
  and Phase 3 (annotation) not built.
- 2026-07-31 — **Built Phase 2** ("My requests" loop-back): added a second **"My requests"** tab
  to the submit modal — a read-only, realtime (`change-requests-mine` channel + self-heal) list of
  the user's own rows (`submitted_by_id` filter) showing status pill + the owner's `owner_note`
  back — plus a **per-device unread badge** on the 🚩 button and the tab (`crisdata_seen_requests`
  localStorage seen-map, mirroring the announcement dismiss; pristine `new` never badges). Opening
  the tab clears the badge; unseen updates open the modal straight to it. **Entirely in
  `shared/report-change.js`** — no new table, migration, endpoint, or board wiring; triage side
  unchanged. Migration now applied / feature live. Phase 3 (annotation) not built.
- 2026-07-31 — **Built Phase 3** (capture + annotate): **📸 Grab my board** (one-click viewport
  capture via **html2canvas 1.4.1, MIT, vendored** at `vendor/html2canvas.min.js`, lazy-loaded) +
  **⬆ Upload** both feed a **self-contained SVG annotator** (red arrows, draggable contenteditable
  note bubbles, undo/clear, touch-friendly). On submit, annotated shots **flatten to one PNG** via
  html2canvas and go through the **unchanged Phase 1 upload**; un-annotated shots upload untouched;
  annotation stays optional. **marker.js was rejected** (v2/v3 commercial; Cris chose the
  self-contained annotator). Verified capture + annotate + flatten on desktop and a phone viewport;
  no board HTML / table / endpoint changes (html2canvas is lazy-loaded by the module). All three
  phases now live.
- 2026-07-31 — **Phase 3 UI fix — large "annotate mode"** (§8): the annotator was unusable inside
  the 440 px modal. Now, once an image is present on the Report tab, the modal expands to
  ~92vw × 92vh (max-width 1180) with the pre-capture form collapsed to one compact row and the
  stage dominant; `fitAnnoImage()` contains the board to fit on desktop (no scroll) and fills the
  width + scrolls on phone, where **✋ Move** toggles `touch-action` so a finger can scroll while
  Arrow/Note still draw. Collapses back on remove/close/tab-switch. UI-only in
  `shared/report-change.js`; flatten + upload path unchanged. Verified readable + arrows placing at
  a usable scale on desktop (704×440 board) and phone (full-width, scroll).
