# How the Announcement Banner is wired

> Doc: `/docs/wiring/announcements.md`
> Last updated: 2026-07-30 — verified vs commit `a60bcb7`
> Status: ✅ verified vs commit `a60bcb7` — checked against `shared/announcement-banner.js`, `api/announcement.js`, `migrations/20260730_announcements.sql`, and the two office boards.

## 0. In one line
The owner broadcasts **one short message** to the office team; it shows as a **dismissible
banner** at the top of the **office boards** (advisor + owner). No chat, no to-do.

## 1. Which boards
- **Shows on:** `advisor-board.html` and `owner-board.html` (banner at the top of `.content`,
  above the views, so it persists across tabs).
- **Posts from:** `owner-board.html` **only** — the sidebar **📣 Announcement** tab
  (`#view-announce` → `#announce-manage`).
- **NOT on** the tech-floor screens (`tech-board.html`, `crisdata-floor`, `shop-board.html`) —
  they simply don't include the module.

## 2. What shows
- The **single most-recent ACTIVE, non-expired** announcement (one at a time; a rotating
  carousel is a later phase). Query: `removed_at is null` AND (`expires_at is null` OR
  `expires_at > now`), newest `created_at` first, `limit 1`.
- **Two styles:** `normal` (📣 info, indigo) and `important` (🚨 alert, red + bolder).

## 3. Data — the `announcements` table
`id` (uuid) · `message` (text) · `style` (`normal|important`, CHECK-constrained) ·
`posted_by_name` · `created_at` · `expires_at` (null = never) · `removed_at`
(null = active; set = retired — **append-only**, never deleted).
Migration: `migrations/20260730_announcements.sql`.

**Security (same posture as `calls`):** RLS is on; **anon may SELECT only** — the banner
reads with the board's anon key. **No anon insert/update/delete.** Creating/removing goes
through the service-role endpoint (§5). We did **not** widen anon writes on any table.

## 4. Post / remove (owner)
The **Announcement** tab renders the post panel (`shared/announcement-banner.js`, `manageMount`):
message textarea, style select, an optional **"Hide after"** date, and **Post**. Below it,
the current active announcement with a **Remove** button.
- **Post** → `POST /api/announcement { action:'create', message, style, expires_at, posted_by_name }`.
  `expires_at` is set to **end of the chosen day** (local) so it shows through that day.
- **Remove** → `POST /api/announcement { action:'remove', id }`.
- **One active at a time:** `create` first retires every still-active row, then inserts — so
  there is only ever one active announcement (matches the one-at-a-time display). "Replace"
  is just posting a new one.

## 5. The endpoint — `api/announcement.js`
Service-role (mirrors `api/desk-appointment.js`), because anon can't write `announcements`.
- `create`: validate (message required + ≤500 chars, style whitelist, `expires_at` optional
  valid ISO), retire actives, insert, return `{ announcement }`.
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
- Schema: `migrations/20260730_announcements.sql`.
- Hosts: `advisor-board.html` (`#announce-banner` + display-only init) and `owner-board.html`
  (`#announce-banner`, the `📣 Announcement` sidebar item + `#view-announce` / `#announce-manage`,
  and the init with `manageMount` + `getName`).

## Session change log
- 2026-07-30 — Built v1: `announcements` table (anon SELECT; service-role writes), the
  `api/announcement.js` create/remove endpoint, and `shared/announcement-banner.js` (banner +
  owner post/remove + realtime with encapsulated self-heal + per-device dismiss). Wired into
  the advisor + owner boards; excluded the tech-floor screens.
