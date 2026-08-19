# How the page map is wired

> Doc: `/docs/wiring/page-map.md`
> Last updated: 2026-08-19 — created; replaces the flat 12-name list carried in the
> session handoffs, which recorded *which files exist* and was read as *which pages are used*.
> Verified vs commit `c17db7e`. Status: 🟢 current — every claim below re-checked against
> `crisdata.html`, `vercel.json`, the four board files, and the five unguarded pages this session.

## 0. In one line
Twelve HTML pages deploy; **one** is the front door, **five** are role destinations, **two** are
also embedded inside other boards, **one** is direct-URL only, and **three** are legacy v1 doors
that nothing in the current system links to — and **all twelve** resolve their database by hostname.

## 1. The count that keeps getting misread
There are 12 `*.html` files at the repo root, all git-tracked, all deployed. That number is
correct and has not changed. What the handoff list did **not** record is that *existing and
deploying* is not the same as *reachable* or *used* — six of the twelve are not something a
person navigates to by name. Sections 2–6 are that missing half.

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
- The older phone + PIN form still exists in the file but is **not surfaced** — on load the page
  runs `bootDoor()` instead of `render()`. It is kept for the planned tech door.
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

## 6. Legacy v1 doors — still deployed, no longer used
Three pages are the original "v1" shop tools. The current system **ported** their behaviour into
Manager Board tabs — it did not embed or redirect to them, and the old files were left untouched
and still deploy.

| v1 page | Title | Absorbed into | Ported at |
|---|---|---|---|
| `shop-board.html` | Shop Board | Manager → **Shop Floor** | `gm-board.html:415, 1111, 2890` |
| `tech-board.html` | Shop **Flow** | Manager → **Tech Status** | `gm-board.html:727, 1197, 3677` |
| `teardown.html` | Teardown Tables | Manager → **Teardown** | `gm-board.html:4014` |

Two facts that make these easy to misjudge:

1. **They still link to each other.** Every *live* link to `shop-board.html` in the repo comes
   from `tech-board.html:197` and `teardown.html:120` — two v1 pages linking to a third. Every
   reference from a current board (`advisor-board.html:4477, 5118`, `gm-board.html:415…`,
   `crisdata-floor.html:16`, `crisdata-techboard.html:16, 419`) is a **comment** naming v1 as the
   thing that was ported from. So the cluster looks alive from inside itself and is dead from
   everywhere else.
2. **Two of them have clean URLs.** `vercel.json` still rewrites **`/teardown` → `teardown.html`**
   and **`/tech-board` → `tech-board.html`**. They are not merely reachable by filename; they have
   deliberate short routes. None of the three has an auth guard.

Naming trap: **`tech-board.html` is the v1 "Shop Flow" page and is dead.** The live v2 dispatcher
is **`crisdata-techboard.html`** (§4). The two are unrelated despite the near-identical names.

## 7. `office-login.html`
Reached only from the front door's "Reset password" link. No `OfficeIdentity` guard (correctly —
it is part of getting a session, not something a session protects).

⚠ Its own header comment is **stale**: it describes the page as a Step-1 standalone test page and
a "dead end", and states that "Phone+PIN (`crisdata.html`) … remains the way everyone logs in."
That has not been true since the single front door shipped (§2). The code is right; the comment
is the stale part. It also references `crisdata-office-login-shopfront.html`, a file that **does
not exist** in the repo.

## 8. Which pages resolve a database by hostname — all twelve
Every one of the 12 pages loads `shared/supabase-config.js` and calls
`window.cdSupabaseCreds()`. **No page hardcodes a Supabase URL** (verified: a search for
`https://*.supabase.co` across all 12 returns nothing). So the prod/staging database choice is
made identically on the front door, the five role boards, the two embedded panes, the floor
screen, and all three dead v1 doors:

- **PROD** (`hygemiszxwmyrkmhbjub`) — the apex, `www`, `board.*`, any future
  `*.leetransmissionshop.com` **except** `test.*`, plus the two known prod Vercel aliases.
- **STAGING** (`efhmefpaijjncwgbvwki`) — `test.leetransmissionshop.com`, every Vercel preview,
  and `localhost`.

Consequence worth stating plainly: **the three dead v1 doors also read and write the production
database** when opened on a prod hostname. Dead means "nothing links to them", not "inert".
See [[staging-db]] for the switch itself.

## Known gaps & open questions (as of 2026-08-19)
- **The three v1 doors have no auth guard and still write prod.** No decision recorded on whether
  to retire them, guard them, or drop the two `vercel.json` clean routes. Worth an explicit call
  rather than leaving them to rot in place.
- **`crisdata-floor.html` has no inbound link from anywhere.** Intentional (wall screen) or an
  unfinished wiring step? Not recorded.
- **`office-login.html`'s header comment is stale** (§7) and names a non-existent file.
- Whether `crisdata-techboard.html` and `crisdata-floor.html` should carry their own auth guard,
  given they are unguarded standalone URLs — the techboard inherits protection only when reached
  through the advisor board's iframe, not when opened directly.

## Where it lives in the code
- Front door + role routing: `crisdata.html` (`ROLE_DEST` at `:175`, `boardFor()`, `bootDoor()`).
- Route rewrites: `vercel.json` — `/` → `crisdata.html`, `/teardown` → `teardown.html`,
  `/tech-board` → `tech-board.html`.
- Auth guard: `shared/office-identity.js` (`OfficeIdentity.resolve`, 120-min idle logout).
- Embedded panes: `advisor-board.html:1749` (techboard iframe), `gm-board.html:1223` + `:3984`
  (My Numbers operate-as iframe).
- Hostname → DB: `shared/supabase-config.js` (`pickSupabaseCreds`), loaded by all 12 pages.
- Tab shell: `.sidebar-item[data-view]` + `<div class="view" id="view-…">` in each board.

## Session change log
- 2026-08-19 — Created. Built by reading the code rather than the handoff list: enumerated the 12
  deployed pages, extracted `ROLE_DEST`, mapped every inter-page reference and separated live
  links from ported-from comments, found the two real iframes, checked `OfficeIdentity` presence
  per page, and confirmed all 12 use the hostname creds switch with no hardcoded Supabase URL.
  Corrected two beliefs in circulation: the v2 Tech Board is a tab under the **Advisor** board
  (not the Manager board), and `shop-board.html` is not uniquely dead — `tech-board.html` and
  `teardown.html` are equally dead, and two of the three still hold clean `vercel.json` routes.
  Flagged the stale `office-login.html` header comment (§7). No code changed.
