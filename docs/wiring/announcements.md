# How the Announcement Banner is wired

> Doc: `/docs/wiring/announcements.md`
> Last updated: 2026-07-30 — verified vs commit `PENDING`
> Status: ✅ verified vs commit `PENDING` — checked against `shared/announcement-banner.js`, `api/announcement.js`, the `announcements` migrations, and the four office boards.

## 0. In one line
The owner broadcasts **one short message** to the office team; it shows as a **dismissible
banner** at the top of the **office boards** (advisor + owner). No chat, no to-do.

## 1. Which boards (audience-targeted)
- **Shows on the office boards, each filtered to its own role** — the `role` passed to
  `AnnouncementBanner.init`:
  - **Manager** → `gm-board.html`
  - **Advisor** → `advisor-board.html`
  - **Bookkeeping** → `bookkeeping-board.html`
  - A board only shows an announcement whose **audience includes its role** (§2a).
- **Owner board** (`owner-board.html`) shows the active announcement **unfiltered** — a
  broadcaster preview (init with **no** `role`) — and is where announcements are **posted**
  (the sidebar **📣 Announcement** tab → `#announce-manage`).
- **NOT on** the tech-floor screens (`tech-board.html`, `crisdata-floor.html`,
  `crisdata-techboard.html`, `shop-board.html`) — they don't include the module.
- The banner mounts at the top of each board's `.content`, above the views, so it persists
  across tabs.

## 2. What shows
- The **single most-recent ACTIVE, non-expired** announcement **for this board's role**
  (one at a time; a rotating carousel is a later phase). Query: `removed_at is null` AND
  (`expires_at is null` OR `expires_at > now`) AND (on a role board) `audience @> [role]`,
  newest `created_at` first, `limit 1`.
- **Two styles:** `normal` (📣 info, indigo) and `important` (🚨 alert, red + bolder).

### 2a. Audience targeting ("who sees it")
- Each announcement carries an **`audience`** — any combo of `manager` / `advisor` /
  `bookkeeping`. A role board shows it only if its role is in that set; the owner-board
  preview ignores audience.
- The role filter is applied **in the query** (`.contains('audience', [role])`), so
  `limit 1` returns the most-recent one *for that role* — a board never gets stuck showing
  nothing just because a newer announcement targeted a different role.

## 3. Data — the `announcements` table
`id` (uuid) · `message` (text) · `style` (`normal|important`, CHECK-constrained) ·
`audience` (`text[]` of role keys, NOT NULL, default all three) · `posted_by_name` ·
`created_at` · `expires_at` (null = never) · `removed_at` (null = active; set = retired —
**append-only**, never deleted).
Migrations: `migrations/20260730_announcements.sql` (table) + `_announcements_audience.sql`
(the `audience` column + a GIN index for the `@>` role filter; default all three so any
pre-audience row still shows to everyone).

**Security (same posture as `calls`):** RLS is on; **anon may SELECT only** — the banner
reads with the board's anon key. **No anon insert/update/delete.** Creating/removing goes
through the service-role endpoint (§5). We did **not** widen anon writes on any table.

## 4. Post / remove (owner)
The **Announcement** tab renders the post panel (`shared/announcement-banner.js`, `manageMount`):
message textarea, a **"Who sees it"** picker (Manager / Advisor / Bookkeeping checkboxes,
**default all three**), style select, an optional **"Hide after"** date, and **Post**. Below
it, the current active announcement (with its audience — "seen by …") and a **Remove** button.
- **Post** → `POST /api/announcement { action:'create', message, style, expires_at, audience, posted_by_name }`.
  `expires_at` is set to **end of the chosen day** (local) so it shows through that day.
  `audience` is the checked roles; the client blocks posting with none checked.
- **Remove** → `POST /api/announcement { action:'remove', id }`.
- **One active at a time:** `create` first retires every still-active row, then inserts — so
  there is only ever one active announcement (matches the one-at-a-time display). "Replace"
  is just posting a new one.

## 5. The endpoint — `api/announcement.js`
Service-role (mirrors `api/desk-appointment.js`), because anon can't write `announcements`.
- `create`: validate (message required + ≤500 chars, style whitelist, `expires_at` optional
  valid ISO, **`audience` filtered to known roles — absent → all three, present-but-empty →
  rejected** so an announcement nobody can see can't be created), retire actives, insert,
  return `{ announcement }`.
- `remove`: validate uuid, stamp `removed_at`, return `{ ok:true }`.
- Pure validator `parseAnnouncementBody` unit-tested in `api/announcement.test.js`.
- **Prod-only:** runs on Vercel (needs `SUPABASE_SERVICE_ROLE_KEY`). Reading/dismiss work
  anywhere; posting needs the deployed endpoint.

## 6. Realtime + self-heal (the calls-channel lesson, encapsulated)
- The banner updates **live, no reload**: the module subscribes to `announcements-live`
  (`postgres_changes`, all events on `announcements`) and **refetches** on any change.
- **Connection-health is built into the module**, not left to each board's `VIEW_REFRESH`
  net. `ensureHealth` runs on **focus / visibilitychange / a 60s tick**: it re-subscribes if
  `channel.state !== 'joined'` and refetches when visible. This applies the fix built for the
  caller-card channel — but encapsulated, so a board **can't forget to register it** (the
  exact global-channel gap that bit the caller card can't recur here). Hooks
  `healthy() / resubscribe() / refetch()` are also returned for inspection/testing.

## 7. Dismiss (per device)
Each user can dismiss the banner on their device; dismissed announcement **ids are stored in
`localStorage`** (`crisdata_dismissed_announcements`, capped). A dismissed banner stays gone
**for that user** but still shows for everyone else until they dismiss it or it's
removed/expired. The owner's **manage** panel shows the active announcement **regardless of
dismiss** (so the owner can still Remove it).

## Known gaps & open questions (as of 2026-07-30)
- **v1 = one announcement.** Multiple simultaneous banners / a rotating carousel is a later
  phase; `create` enforces one active row today.
- Graceful pre-migration: if the table is missing (42P01) the banner hides and the manage
  panel shows "Run the announcements migration to enable this."
- No edit-in-place (change text of a live one) — you Remove + Post. Fine for v1.

## Where it lives in the code
- Module: `shared/announcement-banner.js` — `window.AnnouncementBanner.init({ db, bannerMount,
  manageMount, getName, endpoint })`; render, dismiss, realtime + self-heal, post/remove;
  injected `.anc-*` CSS.
- Endpoint: `api/announcement.js` (+ `api/announcement.test.js`).
- Schema: `migrations/20260730_announcements.sql` + `migrations/20260730_announcements_audience.sql`.
- Hosts (banner display, `#announce-banner`, `role`-filtered):
  `gm-board.html` (`role:'manager'`), `advisor-board.html` (`role:'advisor'`),
  `bookkeeping-board.html` (`role:'bookkeeping'`).
- Owner surface: `owner-board.html` — `#announce-banner` (init with **no** `role` → unfiltered
  preview), the `📣 Announcement` sidebar item + `#view-announce` / `#announce-manage`
  (post/remove panel with the audience picker), init with `manageMount` + `getName`.

## Session change log
- 2026-07-30 — Built v1: `announcements` table (anon SELECT; service-role writes), the
  `api/announcement.js` create/remove endpoint, and `shared/announcement-banner.js` (banner +
  owner post/remove + realtime with encapsulated self-heal + per-device dismiss). Wired into
  the advisor + owner boards; excluded the tech-floor screens.
- 2026-07-30 — Added **audience targeting** (§2a): `audience text[]` column
  (`_announcements_audience.sql`), a "Who sees it" picker in the owner panel, and per-board
  `role` filtering. Banner now shows on **gm-board (manager)**, **advisor-board (advisor)**,
  and **bookkeeping-board (bookkeeping)**, each filtered to its role; owner-board stays an
  unfiltered preview. Tech-floor screens remain excluded.
