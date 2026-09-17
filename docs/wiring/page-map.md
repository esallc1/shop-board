# How the page map is wired

> Doc: `/docs/wiring/page-map.md`
> Last updated: 2026-09-17 — the three legacy v1 doors (`shop-board.html`, `teardown.html`,
> `tech-board.html`) were **deleted** along with their two `vercel.json` routes; §0, §1, §6, §8
> rewritten. Originally created 2026-08-19 vs `c17db7e`.
> Status: ⚠ Needs review — §0, §1, §6, §8 and "Where it lives" re-checked vs `9447b68` + this change; §§2–5, 7 last full check vs `c17db7e`.

## 0. In one line
Nine HTML pages deploy; **one** is the front door, **five** are role destinations, **two** are
also embedded inside other boards, and **one** is direct-URL only — and **all nine** resolve their
database by hostname. (The three legacy v1 doors were deleted 2026-09-17 — §6.)

## 1. The count that keeps getting misread
There are **9** `*.html` files at the repo root, all git-tracked, all deployed (12 until
2026-09-17, when the three v1 doors in §6 were deleted). What the old handoff list did **not**
record is that *existing and deploying* is not the same as *reachable* or *used* — several are
not something a person navigates to by name. Sections 2–6 are that missing half.

## 2. The front door — `crisdata.html`
- Served at **`/`** via the root `vercel.json` rewrite `"/" → "/crisdata.html"`.
- The **single front door**: email + password (`db.auth.getSession()` directly), then an
  automatic redirect to the caller's board by role. The map is `ROLE_DEST` (`crisdata.html:175`):

  | role | destination |
  |---|---|
  | `tech` | `my-numbers.html` |
  | `advisor` | `advisor-board.html` |
  | `manager` | `gm-board.html` |
  | `owner` | `owner-board.html` |
  | `bookkeeping` | `bookkeeping-board.html` |

  `boardFor()` returns `null` for any role not in that map, so an unrecognised role gets the
  "signed in, nothing to route to" notice rather than a redirect to `undefined`.
- There is **no phone + PIN form** in this file any more. The old hidden one (`render()` /
  `doLogin()`) was deleted 2026-09-17: it was never shown, and it was the only code that put a
  PIN into a URL (`?u=phone&p=pin`) on the way to a board. On load the page runs `bootDoor()`.
  Techs sign in on `my-numbers.html`'s own PIN screen — and since 2026-09-17 that PIN is checked
  **inside the database** (`login_with_pin`), because `employees.pin` no longer exists on either
  project ([[employee-roster]] §1c, [[my-numbers]] §1).

  There is exactly **one working PIN login per database**: Cristian Tech on prod, ZZ Test Tech on
  the sandbox. Everyone else — all four office users and the other four ZZ accounts — comes in
  through `crisdata.html` with email + password.
- The door deliberately does **not** call `OfficeIdentity.resolve()`: `resolve()` arms the shared
  120-minute idle auto-logout, which redirects to `crisdata.html` — the door must never arm a
  timer pointing at itself.
- Outbound link: **`office-login.html`**, as the "Reset password" link.

## 3. The five role boards
All five are auth-guarded (`shared/office-identity.js` → `OfficeIdentity`) and bounce to the
front door when there is no session.

| Page | Title | Tabs |
|---|---|---|
| `advisor-board.html` | Service Advisor Board | 12 |
| `gm-board.html` | **Manager Board** | 12 |
| `owner-board.html` | Owner Board | 11 |
| `bookkeeping-board.html` | Bookkeeping Board | 10 |
| `my-numbers.html` | My Numbers | — (single view) |

Tabs are `<div class="view" id="view-…">` panes toggled by `display:none`, driven by
`<div class="sidebar-item" data-view="…" data-label="…">`. Nothing reloads on a tab switch.

- **Advisor:** RO Board · Tech Board · Approval Queue · My Commission · Parts · Payments ·
  Customer Log · Customers · Capture Invoice · Desk · To-Do · Team Chat
- **Manager:** Overview · Shop Floor · Tech Status · My Numbers · Teardown · Comebacks ·
  Reports · To-Do · Technicians · Cash Flow · Team Chat · Employees
- **Owner:** To-Do · Marketing Content · Team Chat · Team Comms · Roadmap · Planner ·
  Feature Adoption · Commission & Payout · File Cabinet · Profit by RO · Build Sheet
- **Bookkeeping:** Overview · Unprocessed Invoices · History · Commission & Payout ·
  Capture Invoice · To-Do · Planner · Team Chat · Profit by RO · Build Sheet

## 4. Pages that are ALSO panes inside another board
These deploy as standalone URLs *and* are mounted in an `<iframe>` inside a board. There are
exactly two, and they are the only real iframes in the system (the third `<iframe>` in the repo
is a YouTube embed in the owner board's Marketing Content tab).

- **`crisdata-techboard.html`** ("CrisData · Tech Board", the v2 dispatcher) is iframed into the
  **Advisor** board's *Tech Board* tab (`#view-techboard`, `advisor-board.html:1749`). The board
  itself lives entirely in `crisdata-techboard.html` — no markup or JS is copied into the advisor
  board. The pane stays mounted (only `display:none` toggles) so switching tabs never reloads it
  or drops its Supabase realtime connection.
- **`my-numbers.html`** is iframed into the **Manager** board's *My Numbers* tab as
  `my-numbers.html?as=<phone>` (`gm-board.html:1223` markup, `:3984` src assignment) — the
  "operate-as" view that lets a manager look at any tech's numbers. `my-numbers.html` is
  therefore **both** the `tech` role destination **and** an embedded pane.

**Note the asymmetry:** the embedded v2 Tech Board hangs off the **Advisor** board, not the
Manager board. Only *My Numbers* is an embedded pane under the Manager board.

## 5. Direct-URL only — `crisdata-floor.html`
"CrisData · Shop Floor", the v2 spatial map (Phase 6 Slice 1, read-only: live non-Closed ROs
render as car tiles, all stacked in JUST ARRIVED; placement/drag is a later slice).

**Nothing links to it.** A repo-wide search finds only its own realtime channel name, a design-
language mention in `crisdata-techboard.html`, and one comment in `advisor-board.html:7452`
noting that the floor *deep-links each car back into the advisor board* — i.e. the link runs
floor → advisor, never advisor → floor. It is reached by typing/bookmarking the URL, which
suits a wall-mounted screen. It carries **no auth guard**.

## 6. Legacy v1 doors — DELETED 2026-09-17
Three pages were the original "v1" shop tools. The current system **ported** their behaviour into
Manager Board tabs (it did not embed or redirect to them), so the files were deleted outright,
together with the two `vercel.json` clean routes `/teardown` and `/tech-board`. All five URLs
(`/shop-board.html`, `/teardown.html`, `/tech-board.html`, `/teardown`, `/tech-board`) now 404.

| deleted v1 page | Title | Lives on as |
|---|---|---|
| `shop-board.html` | Shop Board | Manager → **Shop Floor** (`gm-board.html` `#view-shopfloor`) |
| `tech-board.html` | Shop **Flow** | Manager → **Tech Status** (`gm-board.html` "TECH STATUS" block) |
| `teardown.html` | Teardown Tables | Manager → **Teardown** (`gm-board.html` `#view-teardown`) |

Before deleting, every reference was re-checked: the only *live* links to any of the three came
from the three pages themselves (plus the two rewrites). References that remain in current code
(`gm-board.html`, `advisor-board.html`, `crisdata-floor.html`, `crisdata-techboard.html`,
`shared/status-mirror.js`, `shared/warranty-mirror.js`) are **comments** naming v1 as the thing
that was ported from — they name a file that no longer exists, which is expected. `sw.js` and
`manifest.webmanifest` never referenced them.

Naming trap that survives the deletion: the live v2 dispatcher is **`crisdata-techboard.html`**
(§4), unrelated to the deleted `tech-board.html` despite the near-identical name.

## 6a. The "Ask Kiki" chat bot — DELETED 2026-09-17 (Security Phase 3)
A floating avatar button (bottom-right) opened a chat panel on **three** boards — advisor, gm and
bookkeeping — and POSTed the question plus a fresh board-data snapshot to `/api/chat`, which
proxied it to Anthropic with `ANTHROPIC_API_KEY`. **Deleted outright: nobody used it, and it
was an unauthenticated way for anyone on the internet to spend the shop's API credits.** The
endpoint had no auth of any kind — no session check, no origin check, no shared secret; a plain
`POST {question}` from anywhere was answered and billed.

Removed in one commit: `api/chat.js`; the widget markup (`#ai-bubble` / `#ai-panel` …), the
per-board IIFE and the `kiki_bubble_pos_*` localStorage key in all three boards; and the shared
`#ai-*` block in `shared/board-shell.css`. `/api/chat` now 404s. Left in place on purpose:
`kiki-avatar.png` (now referenced by nothing here), `ANTHROPIC_API_KEY` (still used by
`api/extract-invoice.js`), and the separate `kiki/` Next.js app, which has its own
`/api/chat` route and its own deployment.

**`api/extract-invoice.js` is now the only Anthropic caller in this project**, and since the same
day it is **employees-only** — it requires a live Supabase session that maps to an active
`employees` row (`api/_lib/require-user.js`; [[invoice-classify]] §2a).

## 7. `office-login.html`
Reached only from the front door's "Reset password" link. No `OfficeIdentity` guard (correctly —
it is part of getting a session, not something a session protects).

⚠ Its own header comment is **stale**: it describes the page as a Step-1 standalone test page and
a "dead end", and states that "Phone+PIN (`crisdata.html`) … remains the way everyone logs in."
That has not been true since the single front door shipped (§2). The code is right; the comment
is the stale part. It also references `crisdata-office-login-shopfront.html`, a file that **does
not exist** in the repo.

## 8. Which pages resolve a database by hostname — all nine
Every one of the 9 pages loads `shared/supabase-config.js` and calls
`window.cdSupabaseCreds()`. **No page hardcodes a Supabase URL** (re-verified 2026-09-17: a search
for `https://*.supabase.co` across all 9 returns nothing). So the prod/staging database choice is
made identically on the front door, the five role boards, the two embedded panes, and the floor
screen:

- **PROD** (`hygemiszxwmyrkmhbjub`) — the apex, `www`, `board.*`, any future
  `*.leetransmissionshop.com` **except** `test.*`, plus the two known prod Vercel aliases.
- **STAGING** (`efhmefpaijjncwgbvwki`) — `test.leetransmissionshop.com`, every Vercel preview,
  and `localhost`.

The three v1 doors used to be a consequence worth stating: unguarded, unlinked, and still writing
the production database. Deleting them (§6) closed that. See [[staging-db]] for the switch itself.

## Known gaps & open questions (as of 2026-09-17)
- **`crisdata-floor.html` has no inbound link from anywhere.** Intentional (wall screen) or an
  unfinished wiring step? Not recorded.
- **`office-login.html`'s header comment is stale** (§7) and names a non-existent file.
- Whether `crisdata-techboard.html` and `crisdata-floor.html` should carry their own auth guard,
  given they are unguarded standalone URLs — the techboard inherits protection only when reached
  through the advisor board's iframe, not when opened directly.
- ~~The board endpoints take no caller auth~~ — **all six are gated as of 2026-09-17**
  (`extract-invoice`, `announcement`, `change-request`, `desk-appointment`, `recording-links`,
  `recording-assign`) via `api/_lib/require-user.js`, with `shared/auth-fetch.js` sending the
  session token from the boards. The cron pair fails closed on `CRON_SECRET`.
  **Still open: `api/send-push.js`** — it has an origin allow-list plus a shared secret that
  ships in page source, and it still uses the **anon** key for its `chat_members` /
  `push_subscriptions` reads and deletes. It must move to the service-role key (and this same
  caller check) before the Tier-A RLS cutover, or pushes will silently stop.
- **A board opened without a session loses these buttons**, by design: Report-a-change, Post
  announcement, Desk manual-add and recording playback now answer 401 there. Only the
  bookkeeping board currently *has* a gate, so until the auth-gate item lands the symptom on the
  other three is a console line, not a redirect.

## Where it lives in the code
- Front door + role routing: `crisdata.html` (`ROLE_DEST` at `:175`, `boardFor()`, `bootDoor()`).
- Route rewrites: `vercel.json` — `/` → `crisdata.html` (the only rewrite).
- Auth guard: `shared/office-identity.js` (`OfficeIdentity.resolve`, 120-min idle logout).
- Embedded panes: `advisor-board.html:1749` (techboard iframe), `gm-board.html:1223` + `:3984`
  (My Numbers operate-as iframe).
- Hostname → DB: `shared/supabase-config.js` (`pickSupabaseCreds`), loaded by all 9 pages.
- Tab shell: `.sidebar-item[data-view]` + `<div class="view" id="view-…">` in each board.

## Session change log
- 2026-09-17 — Gaps updated: all six board endpoints now require a signed-in active employee; `send-push` is the one left (anon key + a secret that ships in page source).
- 2026-09-17 — Gaps + §6a updated: `/api/extract-invoice` now requires a signed-in active employee (`api/_lib/require-user.js`); the other five board endpoints are still unauthenticated.
- 2026-09-17 — **§6a added: the Ask-Kiki chat bot is DELETED** (`api/chat.js` + the widget on advisor/gm/bookkeeping + the shared `#ai-*` CSS). It was an unauthenticated Anthropic proxy nobody used. Gaps: recorded that `api/extract-invoice.js` and the other board endpoints still take no auth.
- 2026-09-17 — §2: noted that the My Numbers PIN screen now verifies through `login_with_pin` (Security Phase 2, live on both projects) and that it is the only PIN door left. Nothing else re-verified.
- 2026-09-17 — §2: the dead phone/PIN form + `?u=&p=` writer deleted from `crisdata.html`; `ROLE_DEST` still at `:175`.
- 2026-09-17 — **Deleted the three v1 doors** (`shop-board.html`, `teardown.html`,
  `tech-board.html`) and the `/teardown` + `/tech-board` rewrites. Re-grepped for live references
  first (only comments remain). Page count 12 → 9; §0, §1, §6, §8, gaps and "Where it lives"
  rewritten; re-verified all 9 load `shared/supabase-config.js` with no hardcoded Supabase URL.
- 2026-08-19 — Created. Built by reading the code rather than the handoff list: enumerated the 12
  deployed pages, extracted `ROLE_DEST`, mapped every inter-page reference and separated live
  links from ported-from comments, found the two real iframes, checked `OfficeIdentity` presence
  per page, and confirmed all 12 use the hostname creds switch with no hardcoded Supabase URL.
  Corrected two beliefs in circulation: the v2 Tech Board is a tab under the **Advisor** board
  (not the Manager board), and `shop-board.html` is not uniquely dead — `tech-board.html` and
  `teardown.html` are equally dead, and two of the three still hold clean `vercel.json` routes.
  Flagged the stale `office-login.html` header comment (§7). No code changed.
