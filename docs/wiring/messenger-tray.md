# How the Messenger inbox tray is wired
> Doc: `/docs/wiring/messenger-tray.md`
> Last updated: 2026-09-23 — created with step 4 (the tray, **read-only**).
> Verified vs commit: see the change log (the step-4 staging commit; main ships after Cris's OK).
> Status: 🟡 **On staging only** until Cris approves the screenshots. Read-only: no reply, link or Done yet (step 5).
> Related: [[meta-webhook]] (§9 storage, §11 `api/messenger.js`), [[office-auth]] (`is_staff()`), [[call-window-desk]] (untouched).

## 0. In one line
A panel on the right edge of the **advisor board** that lists the shop's Facebook Messenger
conversations still waiting for someone, and shows a conversation's messages when you click it.

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

- **A thread waits** (`isWaiting`) when `done_at` is null **or** `last_inbound_at > done_at`.
  Only a newer **customer** message brings a Done thread back — our replies never do.
- **Auto-open:** after the first load, a refresh whose newest waiting `last_inbound_at` is newer
  than before (`hasNewInbound`) opens the panel. The first load opens it too if anything waits —
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
only, new tab; the link expires). A footer says reply/link/Done come next.

## 4. Where the data comes from — the signed-in session, nothing else
- Reads `social_threads` (200 most recent), `social_messages` (latest per waiting thread; the
  whole open conversation), `customers` (names of linked customers) and `employees_visible`
  (names), all with the **board's own client and the viewer's Supabase session**. The
  `staff_read` policy (`is_staff()`) decides what comes back.
- **No anon fallback, no writes, no endpoint calls.** A test fails if `shared/messenger-tray.js`
  ever contains `.insert/.update/.upsert/.delete`, `/api/messenger`, or a service key.
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
- **Read-only.** Reply box, Link to customer and Done are step 5 (`api/messenger.js` is ready).
- **Up to 200 threads / 500 messages** per read — fine for the shop's volume; paginate if that changes.
- **No sound / push** for a new message (out of scope for this slice).
- Attachment links are Meta's and expire; nothing is copied.

## Where it lives in the code
- `shared/messenger-tray.js` — the DOM half: `mountMessengerTray({ db })`.
- `shared/messenger-tray-logic.js` — pure rules: `isWaiting`, `waitingThreads`, `threadName`,
  `windowLabel`, `previewText`, `attachmentLabel`, `messageByline`, `timeLabel`, `newestInbound`,
  `hasNewInbound`, `latestByThread`. Tested by `shared/messenger-tray-logic.test.js`.
- `shared/messenger-tray.css` — the look (z 2900, the 900 px breakpoint).
- `advisor-board.html` — the stylesheet `<link>` in `<head>` and the mount module before `</body>`.
- Tables: `social_threads`, `social_messages` (`migrations/20260923_social_messaging_*.sql`).

## Session change log
- **2026-09-23** — created. Step 4: read-only tray on the advisor board (list + conversation, hide/tuck/auto-open, staff session only, realtime + 60 s catch-up). On staging first; `main` waits for Cris's OK on the screenshots.
