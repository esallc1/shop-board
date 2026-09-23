# How the Messenger inbox tray is wired
> Doc: `/docs/wiring/messenger-tray.md`
> Last updated: 2026-09-23 — **step 5: reply, link / unlink and Done in the tray** (§3a), all through
> `api/messenger.js`. Created the same day with step 4 (read-only).
> Verified vs commit `bc52dd2` (the commit that SHIPPED the sent-before-Done fix — prod + staging, 2026-09-23).
> Status: 🟢 **LIVE on prod with real Messenger traffic** — proven end to end 2026-09-23 with Cris's personal
> account ([[meta-webhook]] §8b): auto-open, real name, a reply delivered to Messenger, a Business Suite echo.
> Real customers only after App Review (role-holders only until then).
> Related: [[meta-webhook]] (§9 storage, §11 `api/messenger.js`), [[office-auth]] (`is_staff()`), [[call-window-desk]] (untouched).

## 0. In one line
A panel on the right edge of the **advisor board** that lists the shop's Facebook Messenger
conversations still waiting for someone; click one to read it, reply to it, link it to a customer,
or mark it Done.

## 1. Where it lives on the page
- Mounted **once** by `advisor-board.html` — a module just before `</body>` calls
  `mountMessengerTray({ db })` with the board's own Supabase client. It appends `#mtray` to
  `<body>`, **outside every view**, so it is on every advisor tab. No other board mounts it.
- **z-index 2900** (panel and strip): below every modal (3000), the call-log drawer (3300), the
  call card (4000), the mobile sidebar (4500) and Team Chat toasts (9999). It never paints over them.
- **Open, ≥ 900 px wide:** `body.mtray-open` gives `.main-area` `padding-right: 340px`, so the
  lanes move over instead of being covered. **Below 900 px:** the panel overlays (max 92vw).
- The call card, call log, Desk lanes and Team Chat are untouched.

## 2. The three looks
| Look | When | What |
|---|---|---|
| **hidden** | signed-in staff, nothing waiting | nothing on screen |
| **open** | something waiting (first load, or a NEW customer message), or the strip was clicked | 340 px panel: list, or one conversation |
| **tucked** | "Hide »" was clicked while something waits; or a sign-in/permission/load problem | thin strip on the right edge: blue **f** badge + a red count (or an amber **!**) |

- **A thread waits** (`isWaiting`) when `done_at` is null **or** a customer message **arrived** after
  it: `last_inbound_received_at > done_at` (`inboundArrivedMs`; a row without the column falls
  back to `last_inbound_at`). **Arrival, not Meta's send time** — a message sent 10:00:00, Done at
  10:00:05, delivered 10:00:06 brings the thread back. `last_inbound_received_at` is stamped with
  `now()` by `social_record_message` only for a NEW inbound message
  (`migrations/20260923_social_inbound_received_*.sql` — **applied + verified 9/9 on SANDBOX and PROD,
  2026-09-23**). Our replies never bring a thread back.
  The **24 h reply window still runs on `last_inbound_at`** (Meta's rule, Meta's clock).
- **Auto-open:** after the first load, a refresh whose newest waiting **arrival** time is newer
  than before (`newestInbound` / `hasNewInbound`) opens the panel — so a late delivery with an older
  Meta timestamp still opens it. The first load opens it too if anything waits —
  **unless** the viewer tucked it and nothing newer has arrived since (`localStorage
  cdMtrayTuckedAt` = the newest inbound when they tucked; per browser, a convenience only).
- If nothing waits, it hides — except while a conversation is open on screen.

## 3. What it shows
**List** (waiting only, newest activity first): the name (`threadName`: linked customer's name >
Facebook `display_name` > **"Facebook user"**), a short time, the last message's preview
(`previewText` — "Shop: …" for any shop reply, "Not sent: …" for a failed send, "📷 Photo" for an
attachment-only message), and the reply-window chip (`windowLabel`: "Nh left to reply", "Nm
left" in amber under an hour, grey "Reply window closed" after 24 h — the same 24 h rule
`api/messenger.js` enforces).

**Conversation** (click a row): every message oldest → newest (up to 500). Customer on the left,
the shop on the right. Under our messages: **"via Facebook app"** for a Business Suite reply
(`source page_inbox`), **"CrisData · <employee>"** for a CrisData reply (`sent_by` →
`employees_visible` name), plus the time (shop time). A failed send is red with **"Not sent —
<reason>"** (`send_error`). Attachments show as "📷 Photo — view" linking to Meta's URL (https
only, new tab; the link expires). The viewer's own replies are named from the board's identity
(`viewer` getter → `CURRENT_EMPLOYEE_ID` / `CHAT_IDENTITY.name`, `bylineWithViewer`) because
`employees_visible` hides `is_test` accounts — so a ZZ login still reads "CrisData · ZZ Test Advisor".

## 3a. The actions (step 5) — all through `api/messenger.js`
Every action is `cdAuthFetch(db, '/api/messenger', …)` — the viewer's session as a bearer token;
the server checks it (`requireUser`) and writes with the service key. The tray never writes a row.

- **Reply** — the box at the bottom of a conversation (`.mtray-compose`, **outside** the redrawn
  area, so a realtime refresh never wipes a draft; drafts are kept per conversation). **Enter**
  sends, **Shift+Enter** is a new line. While sending: button disabled ("Sending…"), text kept.
  Success → box cleared, the reply appears as "CrisData · <employee>". Failure → text **stays**,
  "Not sent — <reason>" above the box, and the stored failed message shows red in the
  conversation. `token_expired` (Meta code 190) or `not_connected` (no Page token) → a red banner
  under the tray header: **"Facebook isn't connected — tell Cris. …"** (cleared by the next good
  send). A 401 says to sign in again. (`replyError`)
- **Window closed** (`composeState`, same 24 h rule as the server) → the box and Send are
  disabled with **"Facebook only lets us reply within 24 hours of their last message — call them
  instead."**, plus a **📞 Call <number>** `tel:` link when the thread is linked to a customer with
  a phone. The server re-checks anyway (409).
- **Link to customer** — header button → an in-tray picker over the panel: the **same** full,
  paginated, archive-filtered list the Desk's picker uses (`window.cdFetchAllCustomers`) and the
  **same** search rules (`searchCustomers` = the Desk's `renderAttachList`: no query → 30 most
  recently invoiced; name/business contains; ≥ 3 digits against the last 10 of either phone; max
  60) and row styling (`.desk-attach-item`). *Not* the Desk's own picker instance: that one lives
  inside the call-log drawer and is wired to attach a **call** (`performAttach` → `calls`).
  Picking a customer → `link`; the header and list switch to the customer's name at once.
- **Unlink** — small underlined link on a linked thread → inline "Unlink from <name>? Yes, unlink /
  Cancel" (no blocking `confirm()`) → `link` with `customer_id: null`.
- **✓ Done** — header button, no confirm → `done`; the conversation closes, the list redraws
  without it; if nothing is left waiting the tray hides. A newer customer message brings it back
  (§2) — nothing un-does Done.
- Errors on link / unlink / done show in red under the header buttons.

## 4. Where the data comes from — the signed-in session, nothing else
- Reads `social_threads` (200 most recent), `social_messages` (latest per waiting thread; the
  whole open conversation), `customers` (names of linked customers) and `employees_visible`
  (names), all with the **board's own client and the viewer's Supabase session**. The
  `staff_read` policy (`is_staff()`) decides what comes back.
- **No anon fallback and no direct writes.** The only write path is `cdAuthFetch` → `/api/messenger`
  (§3a). A test fails if `shared/messenger-tray.js` ever contains `.insert/.update/.upsert/.delete`,
  a service key, a bare `fetch('…')`, any other `/api/` path, more than one `cdAuthFetch(` call, or an
  action other than reply / link / done.
- `customers` reads now include `phone_primary, phone_secondary` (the header number + tap-to-call).
- **No session** (a board opened on a stale phone/ID identity) → strip with "!", and the panel says
  **"Sign in from CrisData to see Facebook messages."** A session that isn't staff (`rpc('is_staff')`
  false — e.g. a KiKi login) → **"This sign-in can't see Facebook messages."** A load error with
  nothing loaded yet → "Couldn't load Facebook messages" (retries); after a good load, a small
  warning over the last good list. Never an empty-looking tray.

## 5. Refresh
- **Realtime:** one channel, `advisor-board-messenger-live`, `postgres_changes` `*` on both tables
  → a 300 ms-debounced reload. Opened only after the session is known to be staff, with
  `db.realtime.setAuth(access_token)` first, so the socket runs as the viewer and RLS applies.
- **Catch-up:** a reload every 60 s regardless, for a dropped socket.
- Overlapping reloads collapse into one follow-up.

## Known gaps & open questions (as of 2026-09-23)
- **No "un-done"** and no retry button for a failed send (retype and send).
- ~~A message sent just before Done but delivered just after didn't bring the thread back~~ —
  fixed 2026-09-23 with `last_inbound_received_at` (§2); migration applied on both DBs, code live
  (`bc52dd2`).
- **The picker's customer list is cached** for the page's life (like the Desk's); a customer created
  after the first open won't appear until reload.
- **Up to 200 threads / 500 messages** per read — fine for the shop's volume; paginate if that changes.
- **No sound / push** for a new message (out of scope for this slice).
- Attachment links are Meta's and expire; nothing is copied.

## Where it lives in the code
- `shared/messenger-tray.js` — the DOM half: `mountMessengerTray({ db })`.
- `shared/messenger-tray-logic.js` — pure rules: `isWaiting`, `waitingThreads`, `threadName`,
  `windowLabel`, `previewText`, `attachmentLabel`, `messageByline`, `timeLabel`, `newestInbound`,
  `hasNewInbound`, `latestByThread`, and (step 5) `composeState`, `replyError`, `searchCustomers`,
  `bylineWithViewer`, `WINDOW_CLOSED_TEXT`. Tested by `shared/messenger-tray-logic.test.js`.
- `api/messenger.js` — the server half of every action ([[meta-webhook]] §11).
- `scripts/meta-sim.mjs` — `META_SIM_AGE_HOURS` (closed-window thread) and `META_SIM_PSID` (a new
  message into an existing thread) for testing on staging.
- `shared/messenger-tray.css` — the look (z 2900, the 900 px breakpoint).
- `advisor-board.html` — the stylesheet `<link>` in `<head>` and the mount module before `</body>`.
- Tables: `social_threads`, `social_messages` (`migrations/20260923_social_messaging_*.sql`).

## Session change log
- **2026-09-23** — **live on prod, proven with real traffic** (~8:03–8:10am, build `0e644cc`, Cris's personal Facebook account → Page `821690607890680`): "Test 1 from Cris" → the tray **auto-opened**, named **"Cristian Mendez"**, chip "23h left to reply"; a reply typed in the tray arrived in his Messenger and shows as **"CrisData · Cristian"**; a Business Suite reply appeared as **"via Facebook app"**. See [[meta-webhook]] §8b.
- **2026-09-23** — PROD migration `20260923_social_inbound_received_PROD.sql` run by Cris: Success, verify **9/9 ok** (env "PROD — KiKi hygemiszxwmyrkmhbjub"; column timestamptz; backfill 0 missing; function stamps arrival; definer + pinned path; anon/auth no execute, service_role yes; one function; anon no table access; authenticated select-only). Then `main` fast-forwarded `2ffed87..bc52dd2`; www / board. / apex byte-identical (6 served files; migrations 404).
- **2026-09-23** — sent-before-Done fix **proven on test.*** (`59b05eb`; SANDBOX migration applied + 9/9 verify by Cris). Thread `SIM_1790159820077`: Done at 11:01:33.409Z → a re-delivered inbound mid and a NEW page-inbox echo left it Done (`last_inbound_received_at` unchanged at 10:39:23; the echo only moved `last_message_at`) → customer messages stamped 11:00:57/58 (**before** Done) delivered 11:02:03 (**after**) → back in the tray, `last_inbound_at` 11:00:58 < `done_at` < `last_inbound_received_at` 11:02:03.956Z; the window chip still counts from 11:00:58. PROD migration + `main` still pending.
- **2026-09-23** — sent-before-Done fix: the waiting rule and auto-open now use **arrival** (`last_inbound_received_at`, stamped by `social_record_message`); the 24 h window stays on `last_inbound_at`. Migration `20260923_social_inbound_received_*` (commit `cba86f0`); tray code held until the SANDBOX migration is applied.
- **2026-09-23** — step 5 shipped to prod as `fb66aba` after Cris's OK (fast-forward `c5fe657..fb66aba`); www / board. / apex byte-identical for all 6 changed served files.
- **2026-09-23** — browser run on test.* (ZZ Test Advisor): reply (dry-run), Shift+Enter, link, unlink (inline confirm), relink, closed-window box + tap-to-call, Done, a new message bringing the thread back (auto-open) — all PASS. `meta-sim` now stamps messages into a REUSED thread 1 s apart ending now (a 60 s backdate put them before the Done). Gap recorded: sent-before-Done / delivered-after.
- **2026-09-23** — **step 5: tray actions** (§3a), code `84e1e78`: reply box (Enter/Shift+Enter, draft-safe, closed-window reason + tap-to-call, failed → red, not-connected/190 → banner), Link (in-tray picker, Desk's list + search rules) / Unlink (inline confirm), ✓ Done. "Read-only" footer removed. On staging.
- **2026-09-23** — shipped to prod as `c1bd923` after Cris's OK on the screenshots (fast-forward `54d3b0e..c1bd923`). www / board. / apex: `/api/version` = `c1bd923`; `advisor-board.html`, the three `shared/messenger-tray*` files, `file-cabinet.js` and both docs byte-identical. Prod not eyeballed signed-in (no prod sign-in; empty tables anyway). Browser checks on test.*: open (desktop pad + <900 overlay), conversation, tucked, auto-open via realtime in ~7 s.
- **2026-09-23** — preview prefix "You:" → "Shop:" (a Business Suite reply isn't the viewer's).
- **2026-09-23** — created. Step 4: read-only tray on the advisor board (list + conversation, hide/tuck/auto-open, staff session only, realtime + 60 s catch-up). On staging first; `main` waits for Cris's OK on the screenshots.
