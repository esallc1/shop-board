# How My Numbers (the tech's phone tool) is wired

> Doc: `/docs/wiring/my-numbers.md`
> Last updated: 2026-08-22 — §2's trilingual note now carries the **standing Creole cleanup**,
> and the RO-photo grids moved to **per-RO buckets** ([[ro-photos]] §3/§3a). Verified vs
> `085e239` + the slice-3 working tree (UNMERGED).
> Status: ⚠ **Needs review.** The 2026-07-30 pass below is still the last full verification of
> §§1, 3–8; only the language note, the photo grids and the gaps list were re-checked against
> the code on 2026-08-22. Several §§ predate the RO Diagnosis tab's later slices.
> Previously: 2026-07-30 — verified vs commit `be6cef7`, every claim re-checked against
> `my-numbers.html` and its consumers on `advisor-board.html`, `gm-board.html`,
> `crisdata-techboard.html`, and `shared/status-mirror.js`.

## 0. In one line
**My Numbers is the phone app a tech logs into to see the cars assigned to them, walk each
job through its status buttons (Start Diagnostic → Submit → Go Ahead → Complete), diagnose
CrisData ROs (codes + typed/recorded recommendation), and punch the time clock.** It is a
single self-contained HTML file that talks straight to Supabase with the anon key.

## 1. Entry points & files
- **The whole app is one file: `my-numbers.html`** (~1.9k lines, all HTML/CSS/JS inline). No
  build step, no framework — a hand-rolled `STATE` object + `render()` that swaps `#app`'s
  innerHTML per view (`login | list | detail | roDiag`).
- **Shared scripts it pulls in:** `shared/pwa-register.js` + `/manifest.webmanifest` (it's an
  installable PWA), `shared/version-check.js`, `shared/photo-compress.js`,
  `shared/photo-buckets.js`, `shared/ro-media.js`, `shared/tech-findings.js`, and the Supabase JS
  SDK from jsDelivr CDN.
- **NO "Catch this moment" FAB — removed 2026-08-25.** It is a *marketing* capture: its photos go
  to the owner's Marketing tab, **not** to the repair order. On a tech's phone that put a big
  purple camera button inches from the real one, so a photo of the job could land somewhere the RO
  would never show it — and it sat on top of the bucket heading while doing it.
  `shared/catch-moment.js` is **untouched** and still runs on every other board; it mounts nothing
  on its own, so simply not calling `init()` is the whole removal. Three deletions in this file:
  the `<script src>`, the `init()` call, and the now-dead `body:has(.sticky-cta) #cmFab` lift rule.
- **No API/serverless files.** Every read and write is a **direct Supabase call from the
  browser** using the publishable anon key hard-coded at `my-numbers.html:336-338`. There is
  **no service-role endpoint anywhere in this subsystem** (contrast the recordings/RO slices).
- **How a tech reaches it — four auth paths** (see `boot()` at the bottom of the file):
  1. **Direct visit + PIN** — the login screen: phone (10 digits) + 4-digit PIN, verified live
     against the `employees` table (`findEmployee`).
  2. **Pass-through link `?u=<phone>&p=<pin>`** — auto-authenticates, then strips the query from
     the URL (`history.replaceState`). Used to hand a tech straight in from CrisData.
  3. **Session restore** — after a successful login the tech's **phone** (never the PIN) is
     stored in `localStorage['myNumbersTechId']`; a reload restores the session silently.
  4. **Operate-as `?as=<phone>`** — the manager path. `gm-board.html` embeds
     `my-numbers.html?as=<techPhone>` in a same-origin `<iframe>` (its "My Numbers" tab) so
     Kevin can *see and use* a tech's board. Gated by `isSafeEmbeddedAs()`: must be inside an
     iframe **and** `window.top` must be same-origin, else `?as=` is ignored and the PIN screen
     shows. In this mode `AS_MODE=true` hides the logout chrome and **no session is persisted**
     — closing the frame ends it, and every write lands on that tech's real jobs.

## 2. What a tech sees and can do (step by step)
The signed-in view (`renderList`) is: greeting ("Hi, <name>" with avatar) · **Flagged Hours —
This Week** hero · **Time Clock** card · three tabs.

- **Tab "Up Next"** — cards for the tech's jobs in states new/diagnosing/waiting/approved/
  in_progress. Tapping a card opens the **job detail** view.
- **Tab "History"** — the tech's `done` jobs.
- **Tab "RO Diagnosis"** — CrisData ROs assigned to this tech for diagnosis (separate system,
  see §6b). Count badge = ROs still needing a diagnosis.

**Job detail — the one-button-per-state workflow** (`renderDetail` / `bindDetail`). The single
sticky bottom CTA changes with the job's derived status:
- **New** → *Start Diagnostic* (the diagnosis textarea is disabled until you start).
- **Diagnosing** → type your findings, then *Submit Diagnosis to Service Writer* (requires ≥3
  chars of notes).
- **Awaiting Approval** → disabled *Waiting on Service Writer Approval…* (no tech action).
- **Approved** → *Go Ahead — Start The Job*.
- **In Progress** → *Mark Job Complete*.
- **Complete** → disabled, plus a small *← Back to In Progress* self-correction undo.
- **Photos**: "Before" and "Part/Repair" photo pickers exist but are **local-only** — held in
  memory, **never uploaded** (there is no Supabase photo storage in this file). They vanish on
  reload. A repeat-visit "Vehicle History" block also renders here (see §8 caveat — it's buggy).

**Time Clock card** (`renderClock` / `performPunch`): a 4-step cycle — Clock In → Out (Lunch)
→ Back (Lunch) → Out (End of Day) — writing one row per tap to the `punches` table. The two
clock-**out** taps show a confirm dialog first (a mis-tap loses time); clock-**in** is one tap.
Punch state is rebuilt from today's rows on load, but the in-memory step also advances even if
the write is blocked by RLS (`42501`) so the UI never wedges.

**Everything is trilingual** (EN / ES / HT) via the `I18N` map + `t()`, switchable inline.

> ### ⚠ STANDING CLEANUP: Haitian Creole (HT) is no longer needed anywhere in the app
> Decided 2026-08-22. **Alex was the only Creole speaker on the crew and he has retired**, so
> the `ht` block in every `I18N` map is now dead weight that every future string still has to be
> written in. **Spanish stays** — the shop expects to keep having Spanish speakers.
>
> **Deliberately NOT removed in the slice-3 session**, so that a photo-bucket change did not turn
> into an app-wide string sweep. Recorded here so it is *decided* rather than rediscovered in six
> months by someone dutifully translating a new label into a language nobody reads.
>
> When it is done, it is a sweep and not a one-liner: the `ht` blocks in `my-numbers.html`, the
> language switcher's third option, and any other board carrying an `I18N` map. Check
> `employees` for a `language`/locale preference still pointing at `ht` before pulling it.
> New strings written in the meantime may skip `ht`.

**Bucket names are the ONE exception to trilingual** — they are free-typed by the office, stored
once, and shown **verbatim in English** in every language. There is no `name_es`/`name_ht`
(decision 2026-08-22). Only the chrome around them ("No bucket", "Add Photo", the toasts) is
translated. The old `beforePhotosLabel`/`partPhotosLabel` keys were deleted, not left dead.

## 3. Data model — what it reads and writes (all via the anon key, no server)
**Reads:**
- `shopboard_lifts`, `shopboard_parking`, `shopboard_pickup` — filtered `assigned_tech == tech.name`
  (a **name** match, not id). Columns: `po, vehicle, status, work, notes, tech_notes,
  job_category, customer, warranty, flag_hours, diagnosing_at, waiting_at, approved_at,
  tech_started_at, tech_finished_at, created_at`. `shopboard_pickup` has **no `status` / no
  `flag_hours`** column (any pickup row is treated as terminal/`done`).
- `repair_orders` where `technician == tech.name`, embedding `customers(name, phone_primary)` and
  `vehicles(year, make, model, engine, vin, plate, plate_state, transmission_code)`, plus the
  handoff stamps `diagnosis_recommendation, diagnosis_submitted_at, diagnosis_reviewed_at`.
- `ro_diagnostic_codes` (per RO), `attachments` (kind=`diagnosis_audio`, per RO) + short-lived
  **signed URLs** from the private `crisdata-attachments` storage bucket.
- `employees` — for login verify (`phone,pin,role,active`), session restore, and the greeting
  (`name,photo_url`). `punches` — today's rows to rebuild the clock.

**Writes (all anon, all client-side, no ownership check on the server):**
| What | Where | Path |
|---|---|---|
| Job status + `*_at` stamps + `tech_notes` | `shopboard_lifts` / `shopboard_parking` `.update()` by row id | `writeJobStatus` |
| Time punches | `punches` `.insert()` | `performPunch` |
| RO diagnosis submit (`diagnosis_recommendation`, `diagnosis_submitted_at`, clears `diagnosis_reviewed_at`) | `repair_orders` `.update()` by id | `submitDiagnosis` |
| DTC codes | `ro_diagnostic_codes` `.insert()` / `.delete()` | `addCode` / `removeCode` |
| Voice notes | `crisdata-attachments` storage `upload`/`remove` + `attachments` row `insert`/`delete` | `uploadClip` / `deleteClip` |

There is **no write to `shopboard_pickup`** — pickup rows are terminal (`writeJobStatus` refuses
them). `job_category` and `flag_hours` are **read but never written** here (the advisor/manager
own those). Photos are captured but never written.

## 4. Status is a DERIVED state machine, not a stored field
The six chips a tech sees are **derived** by `sbStatusToLocal(row, table)` from the **raw
`status` column PLUS the `*_at` timestamps**. `localStatusToSb` + the per-transition `*_at`
stamp is the reverse, and `writeJobStatus` is the single writer that keeps them consistent
(`crisdata-techboard.html` copies `sbStatusToLocal` verbatim so the dispatcher can never
disagree — see `tech-board.md` §3).

| Derived chip | Raw `status` | + timestamp | Written by |
|---|---|---|---|
| **New Assignment** | `waiting-tech` | no `diagnosing_at` | advisor assign |
| **Diagnosing** | `waiting-tech` | `diagnosing_at` set | tech: Start Diagnostic |
| **Awaiting Approval** | `waiting-auth` | `waiting_at` (+`tech_notes`) | tech: Submit Diagnosis |
| **Approved — Go Ahead** | `approved` | `approved_at` (+`flag_hours`) | advisor: Approve Job |
| **In Progress** | `in-progress` | `tech_started_at` | tech: Go Ahead |
| **Complete** | `waiting-pull`, **or any `shopboard_pickup` row** | `tech_finished_at` | tech: Mark Complete |

Two chips (**New** and **Diagnosing**) share one raw value (`waiting-tech`) and differ **only**
by `diagnosing_at`. So writing the raw column alone would desync the chip from the tech's
"time-in-state" — which is exactly why `status-mirror.js` and the gm-board floor dropdown write
the raw column only, and My Numbers owns the `*_at` stamps.

**Does it represent waiting-on-approval / waiting-on-parts?**
- **Waiting-on-approval: YES** — that's the *Awaiting Approval* chip (raw `waiting-auth`).
- **Waiting-on-parts: NO — and this is a real hole.** The floor `status` vocabulary is much
  wider than the six values above. Per `shared/status-mirror.js` (copied verbatim from the
  shop-board / gm-board dropdowns) the raw column can also be `waiting-part`, `waiting-quote`,
  `waiting-install`, `waiting-pull`, `qc`, `delayed`, `done`, or `empty`. `sbStatusToLocal`
  maps only 5 of these; **everything unmapped hits the `return 'new'` catch-all.** So a car a
  manager sets to **"Waiting for Part"**, "Waiting Quote", "QC", "Delayed", or even **"Done /
  Ready"** (raw `done`, which is *not* `waiting-pull`) shows up in the tech's Up Next as a
  brand-new assignment with a *Start Diagnostic* button. (See Open seams.)

## 5. Realtime — one channel, refetch-on-change, reconnect-aware
- Subscribes to a single channel `my-numbers-live` on `postgres_changes` `*` for the three
  `shopboard_*` tables. Any change → `realtimeRefresh()` → draft-preserving refetch
  (`refreshData`) + re-render. The `assigned_tech` filter (in `loadSupabaseData`) decides what
  shows — no per-row patching. This deliberately reuses two proven patterns: the tech board's
  refetch-on-change and the advisor Approval Queue's **refetch on every `SUBSCRIBED`**.
- **Dropped-socket / backgrounded-tab handling:** on every `SUBSCRIBED` (re)connect it refetches,
  so events missed while the phone slept/backgrounded are caught the moment the socket comes
  back. This is the intended fix for the same failure class as the call-feed bug.
- **Guard against yanking state mid-action** (`rtShouldDefer`): a remote refetch is deferred
  while a write is in flight **or** while the tech is in the detail/roDiag view, then flushed
  once they're idle on the list. `refreshData` also preserves not-yet-submitted diagnosis text
  and local photos across a reload.
- **Where realtime does NOT reach (see Open seams):** the **RO Diagnosis** data
  (`repair_orders` / `ro_diagnostic_codes` / `attachments`) has **no subscription** — that tab
  only updates on manual **Refresh**, tab re-entry, or re-login. And there is **no heartbeat /
  polling fallback**: if the socket dies *without* re-firing `SUBSCRIBED`, the board sits stale
  until the tech taps Refresh (the 60s elapsed ticker only recomputes the flag-hours hero; it
  never refetches).

## 6. Findings capture — two different mechanisms
**(a) Shopboard job (Up Next):** free-text only. The tech types into the "Your Diagnostic"
textarea; *Submit* writes it to the floor row's **`tech_notes`** column and flips the raw status
to `waiting-auth`. Photos are captured but local-only (§2). No codes, no audio here.

**(b) RO Diagnosis (the structured tool):** for CrisData ROs. Read-only complaint + vehicle
header, then:
- **DTC code chips** — each is one `ro_diagnostic_codes` row (stored UPPERCASE, any format).
- **Recommendation** — a textarea **and/or** voice notes: `MediaRecorder` (webm/opus on
  Android/Chrome, mp4/aac on iOS), capped at **120 s/clip**, uploaded to the private
  `crisdata-attachments` bucket with an `attachments` row `kind='diagnosis_audio'`. Clips are
  the source of truth and can be deleted before submit.
- **The audio-diagnostic loop is only half-wired here: record → upload → log is present;
  there is NO transcription.** The code explicitly defers transcript to "a future Whisper
  backend." The standalone `shop-diagnostic` skill (Whisper → `Vehicle_Diagnostic_Database.xlsx`)
  is a **separate pipeline** not connected to My Numbers.

## 7. Tech → office handoff — both pull-based, no push
There are **two independent handoffs**, and both **surface only in the advisor's Approval Queue**
— nothing actively pings the advisor:
1. **Shopboard:** *Submit Diagnosis* sets raw `waiting-auth`. The advisor's Approval Queue
   (`loadAndRenderQueue`, `QUEUE_STATUSES = ['waiting-auth','waiting-tech']`) picks it up; the
   advisor approves (`approveJob` writes `approved` + `approved_at` + `flag_hours`), which flips
   the tech's chip to *Approved — Go Ahead*.
2. **RO Diagnosis:** *Submit* stamps `diagnosis_submitted_at` (and clears `diagnosis_reviewed_at`).
   The advisor's `loadCdDiagCards()` shows ROs where submitted-and-not-reviewed at the **top** of
   the Approval Queue; "Open in RO Board" stamps `diagnosis_reviewed_at`.
- **The gap:** discovery depends on the advisor *watching the Approval Queue*. There is **no
  notification, no Team Chat ping, no badge outside that one view.** The advisor board does
  subscribe to realtime on that queue, so it updates live *if that screen is open* — but a
  finished diagnosis on a screen no one is looking at just waits.

## 8. Identity & permissions — security posture
- **Viewer identity:** the logged-in `employees` row (`{ id: phone, name, phone, role }`). Session
  is the **phone** in localStorage; the PIN is never stored.
- **Role is loaded but NOT enforced.** `role` rides along on the tech object but nothing in this
  file gates on it — **any active employee** (tech, advisor, or manager) who logs in gets the
  tech UI. The only scoping is `assigned_tech == tech.name` on read.
- **Job scoping is by NAME**, not id/phone — two employees with the same `name` would see each
  other's jobs.
- **Every write path is anon and unauthenticated at the row level.** `writeJobStatus`,
  `submitDiagnosis`, code/clip/attachment writes, and punches all go straight from the browser
  with the publishable key and update rows **by id with no server-side ownership check** — the
  "only my jobs" boundary is a client-side read filter, not an enforced write rule. Anyone with
  the (embedded, public) anon key and a row id can write.
- **Login reads the `pin` column client-side.** `findEmployee` does
  `.select('name, phone, pin, role').eq('phone',…).eq('pin',…)` — i.e. it relies on the anon
  role being able to read `employees` (including `pin`). If RLS on `employees` permits anon
  SELECT of `pin` (which this code's shape implies but this doc **cannot confirm from the client
  alone**), PINs are readable by anyone holding the anon key. **Needs a server-side RLS check to
  confirm/deny** (ask Cris to run SQL — see the "sensitive read via SQL" convention).
- **`?as=` is the one path with a real gate** (`isSafeEmbeddedAs`: iframe + same-origin top),
  and it correctly refuses a raw top-level `my-numbers.html?as=<phone>` visit.

## Known gaps & open questions (as of 2026-07-30)
- Cannot confirm from client code whether anon SELECT of `employees.pin` is actually open —
  needs an RLS check in Supabase.
- **No push/notification on either handoff — still true, and still the biggest gap here.** It
  relies on the advisor watching the Approval Queue. The 2026-08-25 slice put the tech's write-up
  in front of him *once he opens the RO* ([[tech-findings]] §4a) and did **not** solve the alert.
- RO Diagnosis tab has no realtime.
- ~~Photos are captured but never persisted~~ — **fixed.** Photos are real, hang off the repair
  order, and sort into **per-RO buckets**; the grids are on the RO Diagnosis screen, not the
  shopboard job screen (which carries no RO id). See [[ro-photos]] — §3 for capture, §3a for the
  flat-vs-accordion layout the tech sees.
- **HT is dead but still shipped** — see the standing cleanup in §2.

## Open seams / risks (what I'd want addressed before rolling out to techs)
1. **Status desync — unmapped raw statuses collapse to "New" (§4).** A car set to *Waiting for
   Part*, *Waiting Quote*, *QC*, *Delayed*, or *Done/Ready* on the floor shows in the tech's Up
   Next as a fresh assignment with a *Start Diagnostic* button. The tech can then re-drive a
   waiting/finished job and stomp its raw status back through the state machine. **This is the
   highest-impact seam** — the floor vocabulary and My Numbers' six states are out of sync.
2. **Unauthenticated write surface (§8).** Every status/diagnosis/punch write is anon, by row id,
   with no server-side ownership or role check; scoping is client-side only. Combined with the
   possibility that PINs are anon-readable, the whole write surface leans on the anon key staying
   private — which it can't, since it's embedded in a public HTML file. Wants RLS / a
   service-role write path before wider rollout.
3. **Silent-stale on a dead socket + pull-only handoff (§5, §7).** Realtime recovers on
   `SUBSCRIBED`, but there's no heartbeat/poll fallback if the socket dies without reconnecting,
   the RO tab isn't subscribed at all, and a submitted diagnosis only appears in the advisor's
   Approval Queue with no ping — same failure class as the call-feed bug on both ends.

_Also noted (lower severity, real bugs):_ the detail view's **"Vehicle History / worked before"**
match keys on `job.vin`, but `sbRowToJob` never sets `vin` (there's no VIN column) — so every job
has `vin === undefined`, `undefined === undefined` is true, and the block treats **every** other
completed job as prior history for the current car. (The **list**'s "Worked before" flag is fine —
it correctly matches on the `vehicle` string.) The empty `.tag-vin` line renders blank for the
same reason.

## Where it lives in the code
- **The app:** `my-numbers.html` — `sbStatusToLocal` / `localStatusToSb` / `writeJobStatus`
  (status machine), `loadSupabaseData` / `loadAssignedRos` / `loadTodaysPunches` (reads),
  `renderList` / `renderDetail` / `renderRoDiag` (views), `ensureRealtime` / `realtimeRefresh` /
  `rtShouldDefer` (realtime), `submitDiagnosis` / `addCode` / `uploadClip` (RO capture),
  `performPunch` (clock), `boot()` (the four auth paths).
- **Handoff consumers:** `advisor-board.html` — `loadAndRenderQueue` (`waiting-auth`),
  `approveJob` (writes `approved`), `loadCdDiagCards` + `diagnosis_reviewed_at` stamp (RO diag).
- **Operate-as host:** `gm-board.html` "My Numbers" tab (`my-numbers.html?as=<phone>` iframe).
- **Related raw-status writers:** `shared/status-mirror.js` (canonical `STATUS_OPTIONS`),
  `crisdata-techboard.html` (drag-assign + verbatim `sbStatusToLocal`), gm-board / v1
  `shop-board.html` floor dropdowns.
- **Shared:** `shared/pwa-register.js`, `shared/version-check.js`, `shared/photo-compress.js`,
  `shared/photo-buckets.js`, `shared/ro-media.js`, `shared/tech-findings.js`. **Not**
  `shared/catch-moment.js` — see above.
- **Storage:** private `crisdata-attachments` bucket (diagnosis audio).
- **Related docs:** `tech-board.md` (dispatcher side of the same state machine),
  `ro-checkin-tech.md` (tech assignment + `shopboard_pickup` no-`status` quirk),
  `recordings-audio.md` (the audio/attachments pattern), `floor-tags.md` (floor lanes).

## Session change log
- 2026-08-27 — **Video capture, and one gap logged.** Every photo grid gained a second add tile,
  **🎬 Add Video** (`accept="video/*"`, deliberately no `capture`, so the camera roll is reachable
  — a clip is far likelier than a photo to already exist). The clip is the same
  `kind='ro_photo'` row as a photo and files into the same bucket; full reasoning in
  [[ro-photos]] §1d, §3b. Size blocks at 100 MB synchronously; duration only advises. The upload
  status is **persistent, not a toast**, because a 100 MB clip over shop wifi is minutes and a
  toast that vanishes tells the tech it finished. `roPhotoBusy` stays shared with the photo path
  but now says so instead of silently doing nothing.
  Spanish swept from "categoría" to the **bucket** vocabulary (`noBucketLabel`,
  `toastPhotoNoBucket`) so one screen no longer speaks two vocabularies. **No Haitian keys were
  added for video** — `t()` is `I18N[lang][key] || I18N.en[key] || key`, so a missing HT key
  lands on the ENGLISH string, never on the raw key name, which is what makes §2's standing
  Creole decision safe to act on rather than merely intend.
  ⚠ **Logged, not fixed: `escRo` does not escape quotes.** It replaces only `<` and `>` — the
  same gap `escAttr` closed on the advisor board in slice 3. It is safe today because every
  attribute on this screen holds a signed URL or a UUID, and nothing in this slice changed that.
  The first free-typed text to reach an attribute here (a bucket name, a caption) reopens it.
- 2026-08-25 — **Findings are appended, not overwritten** ([[tech-findings]]). `submitDiagnosis`
  now re-reads, prepends a `␞ FINDINGS ␞` entry and writes under an optimistic guard; the tech
  gets **Edit** (rewrite the newest, only until the writer opens it) and **Add follow-up**. The
  recommendation textarea is seeded **empty** — it used to be prefilled with the stored column,
  which with appends would have doubled the history on every submit. Previous entries render
  read-only below the box. **Also removed the "Catch this moment" FAB from this page.**
- 2026-07-30 — Created during the "map My Numbers into the File Cabinet" investigation.
  Documented the four auth paths, the anon-only read/write model, the six-state derived status
  machine and its unmapped-status hole, the single realtime channel + its gaps, the two findings-
  capture mechanisms (free-text `tech_notes` vs structured RO codes/audio, no transcription), the
  two pull-based handoffs, and the identity/permission posture. Flagged the top seams and two
  real bugs (VIN-history mismatch, unmapped statuses). **Investigation only — no app code
  changed.**
- 2026-08-22 — **Standing Creole cleanup recorded (§2), and the photo grids went per-RO.** HT is
  no longer needed anywhere in the app (Alex retired; Spanish stays) — noted, deliberately not
  ripped out in a photo-bucket session. The RO-photo grids stopped being two hardcoded,
  translated grids and became this RO's own buckets, resolved by **id** — a name lookup would
  have filed a photo onto an arbitrary other repair order. Two buckets keep the original flat
  layout; three or more collapse to an accordion. Doc marked ⚠ Needs review: §§1, 3–8 were not
  re-verified this session.
