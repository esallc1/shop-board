# How the call window & advisor Desk are wired

> Doc: `/docs/wiring/call-window-desk.md`
> Last updated: 2026-09-24 — **§2 / §2a / §5: the card lives in the Inbox tray ([[inbox-calls]]), next step is Call back · Coming in · Done (coming), an un-noted call can't be closed, backfill = today's untouched calls** (staging). Previously: 2026-09-22 — §6d.
> Previously: 2026-09-21 (3) — **new §6b (key drop box) + §6c (calendar 7 am–6 pm, same-time chips side by side).** **LIVE ON PROD at `83826ed`** (after `20260921_calls_dropoff_key_box_PROD.sql`, run by Cris), verified vs commit `83826ed`.
> Previously: 2026-09-21 (2) — **new §10: the appointment date + outcome show on the Call Log and the customer record** (no migration; manual "+Add" rows stay out of the Call Log by decision). **LIVE ON PROD at `6733056`**, verified vs commit `6733056`.
> Previously: 2026-09-21 — **§6: each lane scrolls inside its own ~6-row box** so the calendar stays close (CSS only). **LIVE ON PROD at `e74136f`**, verified vs commit `e74136f`.
> Previously: 2026-09-20 (2) — **new §9: the one destructive "Done" is gone.** Four real
> outcomes on Coming-in (Arrived · Reschedule · Not coming · Follow up), a confirm before
> clearing anything still ahead, and a "Recently cleared" undo. "Mark done" is removed from
> the call window. Three new nullable columns on `calls`. **LIVE ON PROD at `1aeb2ee`**
> (2026-09-20 ~08:20 ET; `20260920_calls_outcome_PROD.sql` run by Cris first).
> §5 rewritten (it described the removed button).
> Previously: 2026-09-20 — **§6 + new §6a: the Desk no longer only models the future.**
> Coming-in shows overdue and undated drop-offs, the calendar receives past weeks, and the
> overdue badge counts drop-offs. Display only — nothing about what a drop-off IS changed,
> and resolved rows are still hidden. **Shipped to prod at `cde6aa6`** and verified read-only on
> `board.*`: 24 Coming-in rows = **16 overdue + 3 undated + 5 upcoming**, badge "16 overdue"
> (it read 0 before), banner + tag on 20 rows, `‹ Previous week` drawing past chips back to
> Aug 3–9. Verified on `test.*` first at `cde6aa6` (8 overdue + 3 undated — the sandbox is an
> older, diverged copy).
> Previously: 2026-08-18 — verified vs branch `feat/confirm-phone-learn` (base `7860272`)
> (§2c added: attaching a call no longer writes a phone number silently — it asks. §2 + §3
> already carried the `ro_id`/disposition decoupling. See [[call-auto-attach]] §7 and §8.)
> Status: ✅ verified — the confirm-before-learning flow (§2c) driven end-to-end in the real
> Desk call log with every write intercepted (default-NO, default-YES, decline + no re-ask,
> accept + `learned_phone`); the `ro_id` decoupling exercised on a dry-run card. The rest of
> the doc is unchanged from commit `932950b`.

## 0. In one line
An inbound call pops a card where the advisor picks **what happens next**; that choice
routes the customer to a lane on the **Desk** (a callback, or a drop-off on the
schedule). There is **no separate appointment record** — the `calls` row *is* the
appointment.

## 1. One row per call — the `calls` table
Everything below is columns on a single `calls` row (no appointments table):
`next_step`, `due_at`, `due_all_day`, `ro_id`, `note`, `noted_at/noted_by_name`,
`resolved_at/resolved_by_name`, `customer_id`. `next_step` is CHECK-constrained to the
four values below (or null = not yet chosen). Schema: `20260728_calls*.sql`
(`_notes` adds next_step/due_*/ro_id/noted_*, `_resolved` adds resolved_*).

**RLS:** anon (the board key) may **SELECT** and **UPDATE** `calls`, but **not INSERT**
— row creation is service-role only (the CTM webhook owns it). This is why editing an
appointment is a direct anon UPDATE, but a manual add must go through a server endpoint
(§8).

**Security slice 3 (in progress):** every browser write moves to **`api/calls.js`**
(requireUser = an active employee; a fixed list of actions, each writing only its own columns;
who/when stamped on the server), then the anon + authenticated UPDATE policies are dropped.
Step (a)1 (2026-09-25, **LIVE on prod** `bd78d76`): the call card's `saveNote` / `persistCustomer` and
`autoFileRoForCall` ([[inbox-calls]] §5). Step (a)2 (2026-09-25, **LIVE on prod** `254dc9c`): the six **Desk**
writers — `applyOutcome` / `saveNotNow` → `outcome`, `undoCleared` → `undo`, `resolveCall` → `done`,
`deskEditSave` (edit mode) → `edit`, `rescheduleCall` → `reschedule` (§7, §9). The server builds
every patch with the same shared rules (`outcomePatch`, `undoPatch`, `withKeyBox`,
`reschedulePatch`) and stamps who/when from the signed-in employee; a clear only lands on a row
that is still open (409 "Someone already cleared this…" otherwise, and the Desk reloads). A failed
Desk write never pretends: 401 → the red sign-in banner, anything else → "Could not …: reason"
(alert on a lane button; the red line inside the Edit / Not-now dialog, which stays open as
typed); a dragged chip snaps back. Still direct until (a)3: the Call Log / customer record writes
(attach, un-attach, not-a-customer, learned phone, File to RO).

**Walk-in / manual appointment (no call).** The same single-row model represents an
appointment that never came in as a call — a `calls` row marked "not a real call" by two
fields: `ctm_call_id` = a **synthetic negative id** (real CTM ids are positive, so it
never collides and is trivially identifiable), and `started_at` = **null** (so it never
appears in the day's Call Log, which queries by `started_at` — it lives only on the Desk
via `next_step` + `due_at`). Written by `api/desk-appointment.js` (§8).

## 2. The call window (the popup) — `callerCard` IIFE
- **Where it shows (since 2026-09-24): inside the right-hand Inbox tray, not floating over the board**
  ([[inbox-calls]]). It rings as a pinned caller-ID glance, then waits in the tray's "Needs handling" list;
  tapping it opens this card inside the tray. The old top-right stack (`#callCardStack`, z 4000) is gone.
  The card hands itself to the tray (`placeCard` → `window.cdCallInbox.add`, queued in
  `window.cdCallInboxPending` until the tray mounts).
- Opens on a live inbound call (Supabase realtime **INSERT** on `calls`), one card per
  `ctm_call_id`. Test hook: `window.cdHandleTestCall(call)`.
- The card **autosaves** to the `calls` row as you go (`saveNote` — note on a 2s debounce
  + blur; every other field immediately). The first save stamps `noted_at/noted_by_name`.
- **"Anything left to do?"** (was "What happens next") — single-select chips (`NEXT_STEPS`). Since
  2026-09-24 (Inbox mockup screen 2) only **Call back** and **Coming in** show, plus **Done (coming)**
  (disabled — it needs a "handled" column, Inbox slice 5). The two old chips stay in the DOM **hidden**,
  shown only on a call that already has that step. Same `next_step` values as before:

  | Chip | `next_step` | Date UI | Lands on the Desk as |
  |---|---|---|---|
  | Call back | `quoted_callback` | quick buttons (Tomorrow / In 3 days / Next week) + date; all-day | **Callbacks** lane |
  | Coming in | `dropping_off` | date + optional time (Morning = all-day) | **Coming in** lane + **drop-off calendar** |
  | Checking on their car *(hidden unless already set)* | `checking_on_car` | none (see the RO row below) | (not a Desk lane) |
  | Price shopper *(hidden unless already set)* | `price_shopper` | none | (not a Desk lane) |

- Also on the card since 2026-09-24: **🎧 Recording** (via `api/recording-links`, pending until the
  file is ready) and **Attach… / Start RO / Not a customer** shown as "coming" ([[inbox-calls]] §4).

- **All-day dates** are stored as **noon local** (`toDueAt(date, null)` → `new Date(y,m-1,d,12,0,0)`),
  so the calendar date can't slip a day across a timezone. A specific drop-off time sets
  `due_all_day=false`.

### 2a. The card is realtime — and self-heals a dropped socket
- The card pops from a **realtime INSERT** on `calls` (`subscribeCalls()` →
  `advisor-board-calls-live` → `handleNewCall(payload.new)`). The card is **ephemeral**
  (DOM only) — there is no "card shown" flag in the DB.
- **The problem this channel had:** it is **global** (cards pop on any tab), so it is
  *not* one of the per-view `VIEW_REFRESH` channels the connection-health net watches. If
  its socket dropped (backgrounded tab, device sleep, network blip), Supabase never
  replays the missed INSERTs, so a real call landed in the DB + **Call Log but no card
  popped** — while the log kept working because it re-queries on open. This was **not** a
  render bug; the render path was fine.
- **The fix (self-heal):** the safety net (`ensureCallsHealth`) now, on
  **focus / visibilitychange / the 60s tick, regardless of active view**:
  1. re-subscribes the channel if `cdCallsHealthy()` is false (`cdResubscribeCalls`), and
  2. runs **`backfillRecentCalls()`** (`cdBackfillCalls`) when the tab is visible.
- **Backfill** queries `calls` for **today's untouched, real inbound calls** — `started_at` since local
  midnight, `noted_at is null` (nobody has worked the card), `resolved_at is null`, `ctm_call_id > 0`
  (excludes manual appointments) — newest first, capped at `BACKFILL_MAX` (**25**). (Until 2026-09-24:
  the last 15 minutes, 5 cards.) It runs **1.5 s after page load** too, so an untouched call survives a
  reload ([[inbox-calls]] §3). It pops a card per row via `handleNewCall` (which **dedups** any
  still-open card by `ctm_call_id`).
- A card closed (only possible once it's noted — §5) records its `ctm_call_id` in the in-memory
  `dismissedCardIds` set, so backfill won't re-pop it.

## 2b. "Filed to RO" — its own persistent row (`.cc-filed`, `renderFiledRo`)
**Which RO a call is about is independent of what happens next**, so the RO picker is a
permanent row on the card, shown under **every** disposition and under none. It renders as
soon as a customer resolves (single match or a pick); with no customer it stays empty, and
with a customer who has no ROs it says so.

Options come from `RoCalls.buildRoPickerOptions` **unchanged** — already status-agnostic and
already stage-labelled, so **closed ROs are listed** (`#5451 · Closed`). That is the case
that matters: a customer ringing a week after pickup about the job that just closed.

Choosing an RO goes through `saveNote({ ro_id })`, which also **clears the auto-attach tags**
(`auto_ro_filed_at`, `auto_attach_run_id`) — a human's choice leaves the robot's namespace so
no batch undo can revoke it ([[call-auto-attach]] §3).

⚠️ **This used to be gated.** The picker rendered only under `checking_on_car`, and the chip
handler force-cleared `ro_id` for every other step — so a call filed to an RO lost that link
the moment the advisor picked a different disposition, and a customer calling about a closed
job had nowhere to file it at all. Both behaviours are gone.

## 2c. Attaching asks before it saves a phone number (`.log-learn`)
Attaching a call in the **Desk call log** can also write the caller's number into the
customer's empty `phone_secondary`. That used to happen **silently**, with nothing on screen
to say so — and because the Customer Record unions phone-matched calls, a wrong attach then
dragged every call from that number onto that customer's record ([[call-auto-attach]] §8 has
the incident). The learning is wanted; the silence was the bug. So now it asks.

**When it asks.** Only when a write would genuinely happen — `wouldLearnPhone`: the number
isn't already on the customer, and the `phone_secondary` slot is empty. If nothing would be
learned there is **no prompt** and the attach proceeds exactly as before.

**How it asks.** Inline in the call's own row — *"Also save (305) 393-9103 as a second number
for JOSE RAMIREZ?"* — never a blocking `confirm()`/`alert()`. It renders **from state**
(`pendingLearn`), not injected into the DOM, so a `logLoad()` (realtime, day change, another
attach) redraws the prompt instead of wiping it.

**Which way it starts.** **NO** when that number already has other calls that aren't this
customer's (`phoneLearnDefaultYes` / `countForeignCalls`), with the count shown as the reason.
**Both kinds count as foreign**: a call attached to a *different* customer, and an
**unattached** call — the second is the case that actually bit us (all six of Hector's calls
were unattached). Otherwise **YES**. It is only a default; the advisor can answer either way.
⚠️ A repeat caller from a genuinely new number will therefore default to NO once a couple of
their calls have piled up unattached. Deliberate: declining costs a number nobody typed,
accepting wrongly rewrites a customer record.

**The attach is never blocked.** The call is linked **first**, with `learned_phone` false, and
the evidence lookup runs *concurrently* with that write. Declining, dismissing, navigating
away, or the lookup failing all leave the call attached. Only the phone write is in question.

**Answering yes** runs the same atomic `attachPhoneLearn` as before (`setSecondaryIfNull` —
writes only `WHERE phone_secondary IS NULL`, so a stale snapshot can never overwrite an
occupied slot), then stamps `learned_phone = true` on the call, which is what lets **un-attach
clear the number again** (§unchanged — `unattachClearsSecondary`).

**Declining is remembered** in `localStorage` (`cdPhoneLearnDeclined`), keyed on the
**(customer, number) pair** and capped at 200 entries, so the same question isn't asked again
on the next call from that number.
⚠️ **The cost of that choice, stated plainly:** `localStorage` is **per-browser**, not
shop-wide. Josh declining on the front desk machine does not stop the question appearing for
Kevin on his. A durable shop-wide decline needs a new table (or a column) and therefore a
hand-run migration — which is why it isn't built. Say the word and it becomes one.

## 3. Switching chips clears the date (no stale carryover)
A chip switch **always** resets the date: the handler writes
`{ next_step, due_at: null, due_all_day: true }`. This exists because a date entered under
one step used to ride across into the next — a callback date silently became a drop-off
date. After a switch the advisor re-picks the date from scratch.
**`ro_id` is NOT touched by a chip switch** (§2b) — it survives every disposition change.

## 4. The outcome echo (guardrail)
Under the chips, `.cc-echo` (via `updateEcho`) states **the lane + the weekday** the
moment a step + date are chosen — e.g. `→ Coming in: drop-off Tue, Aug 4 · on the
schedule` (blue) or `→ Callback: Thu, Jul 30` (purple); a "pick a date" prompt until a
date is set; hidden for `checking_on_car` / `price_shopper`. The **weekday** is the
point — it makes a wrong lane or a wrong date (e.g. "Thu, Jul 30" when Tuesday was
meant) visible **before** the card is closed.

## 5. Closing the call window (it can no longer clear anything)
The card has **one** button: **Close** (and the × in its header). It flushes any pending note and
dismisses the card — **but only once the call has been noted** (a note, a next step, or filed to an RO —
all via `saveNote`; the server stamps `noted_at`, and Close waits for that save to come back). On an un-noted call, Close / × say "Add a note or pick
what happens next first — then Close." and keep the card (`tryClose`, Cris 2026-09-24: "a call must
never disappear just because nobody typed anything" — [[inbox-calls]] §3). A callback or drop-off **stays on the Desk** (`resolved_at` null) so it cannot fall
off the radar.

**"Mark done" used to sit next to it and is gone** (2026-09-20). It appeared the instant a
step was picked — i.e. at the exact moment of booking — and set `resolved_at` with no
confirm. Prod audit: of 40 resolved appointments **22 were resolved within 60 seconds of
being noted, by the person who noted them** (fastest 3s, 5s, 6s). Clearing now happens only
from the lanes (§9), where the date you are about to erase is on screen. The call window
writes `resolved_at` **nowhere** — locked by a test.

## 6. The Desk — `desk` IIFE
- `deskLoad` reads `calls` where `next_step in ('quoted_callback','dropping_off')`
  **AND `resolved_at is null`**, ordered by `due_at` asc.
- **Lanes:** **Callbacks** = `quoted_callback` (no date filter — a past-due callback
  shows, in red); **Coming in** = **every** unresolved `dropping_off`, ordered overdue →
  undated → upcoming (§6a); **Declined estimates** = `repair_orders.declined_at` (its own
  restore lifecycle, *not* `resolved_at`).
- **Each lane scrolls in its own box.** All three lane lists share `.desk-lane-body`, capped
  at `max-height: min(420px, 55vh)` (~6 rows) with `overflow-y: auto` +
  `overscroll-behavior: contain`, so a long lane (Coming-in, once §6a surfaced the backlog)
  can't push the drop-off calendar down the page, and a flick at the end of a lane doesn't
  scroll the page on the iPad. The lane head (title + count) sits outside the box and stays
  put; the §6a "recovered" banner is the first child *inside* the box, so it is
  `position: sticky; top: 0`. CSS only — row order is untouched.
- **Drop-off calendar:** `renderCalendar(calendarFeed())` — a week grid of every dated
  unresolved `dropping_off`, **past and future**. The week window is the only date filter,
  so `‹ ›` browses real history. Chips are drag-to-reschedule (`rescheduleCall`). The box
  opens on **7 am–6 pm** and same-time chips sit side by side (§6c); a key-box drop-off is
  an all-day chip with a 🔑 (§6b).
- **Finishing with an item** is §9 — four outcomes on Coming-in, a plain "Done" on
  Callbacks. The old one-click `data-done` → `resolveCall` survives only as the
  pre-migration fallback.

### 6-log. Opening the call log AT one call (top-bar search, 2026-09-23)
`window.cdDeskOpenLogAt(when, callId)` (desk IIFE, next to `openLog` / `setLogDay`) is how the
top-bar search opens a **call-note result whose call has no customer** ([[global-search]]): it
switches to the Desk tab, turns the log's "unattached only" filter off (so the call can't be hidden),
sets the log's day to that call's day (local midnight of `started_at`) and opens the log (or re-loads
it if already open). After that day's `logRender`, the row with `data-log-call="<id>"` is scrolled to
the centre and highlighted (`.log-row-hl`, ~6 s) — `logHighlightCallId` is one-shot. Nothing is
attached: the row's own **"Attach to <name>"** suggestion (a single live phone match, §2c) is what
offers the guess, and it still takes an explicit tap.

## 6a. What Coming-in and the calendar may SHOW — `shared/desk-appointments.js`
Until 2026-09-20 the Desk only modelled the future, and four separate filters threw work
away. A read-only audit of prod on 2026-09-20 found **16 unresolved past-due drop-offs and
3 undated ones** sitting invisible — the oldest from Aug 4, the newest from Sep 18. What
was wrong, and what each now does:

| Was | Now |
|---|---|
| Lane filtered `due_at >= today`, so a drop-off vanished the morning after its date | Lane shows every unresolved drop-off |
| `renderCalendar` was handed that same today-onward array (all 4 call sites), so `‹ Previous week` drew an empty grid whatever had been booked | `calendarFeed()` passes every **dated** drop-off; the week window does the filtering |
| Overdue badge counted callbacks only — a missed drop-off wasn't just hidden, it was uncounted | `overdueCount` counts overdue callbacks **and** drop-offs |
| A drop-off with `due_at` null was dropped by both (each required `c.due_at`) | Shown in the lane under `dueLabel`'s existing **"No date"** |

- **Order in the lane:** overdue first (**oldest miss first** — the one that has waited
  longest), then undated (oldest booked first), then upcoming (soonest first, as before).
  Undated sits *above* upcoming on purpose: burying it under next month's bookings would
  hide it a second way.
- **Look:** an overdue row gets `.desk-row.is-overdue` (red left edge) plus the red due
  date the Callbacks lane already used; an undated row gets a muted edge. A calendar chip
  whose date has gone gets `.desk-chip.is-past` (red edge, muted text) so a past week
  doesn't read like upcoming bookings.
- **One overdue rule.** `isOverdueDue(dueAt, allDay, now)` in the module is THE definition
  for both lanes (all-day = not late until the day is past; timed = the clock; **no date is
  not overdue, it's undated**). The board's local `isOverdue` delegates to it.
- **Resolved rows are still hidden** — `deskLoad` keeps `.is('resolved_at', null)`. Making
  a resolved item visible / un-resolvable is a separate job; see Known gaps.
- **The "recovered" note.** So the reappearing rows don't read as a new bug, a drop-off
  **booked before `RECOVERED_CUTOFF` (2026-09-21)** and either undated or dated before it
  carries a one-line tag (also the chip's tooltip), and the lane carries one banner while
  any such row is still unresolved. A drop-off booked after the cutoff is just normally
  overdue and gets no tag. Both expire on `RECOVERED_UNTIL` (2026-10-05) via
  `isNewBadgeVisible` from [[new-badge]] — the same shop-time rule, so the notice can never
  get stuck on and nobody has to remember to remove it. The banner also disappears early,
  on its own, once the team has cleared the pile.
- **Fail-soft.** The module is ESM on `window.DeskAppointments`, read only inside
  `deskRender` / `renderCalendar` / `calendarFeed`, which never run before a `calls`
  round-trip has resolved. If it is somehow absent, those three fall back to the **old
  today-onward view** rather than throwing.
- Pure, no DOM, every entry point takes `now` → `shared/desk-appointments.test.js`
  (26 cases, incl. board-wiring assertions that no copy of the old filter survives).

## 6b. The key drop box — `calls.dropoff_key_box`
The shop has a **key drop box** at the front door; customers leave cars at 10 pm. A
drop-off's exact time mostly doesn't matter — whether the keys are **in the box** does,
because someone has to check it in the morning.

- **Stored as** `calls.dropoff_key_box = true` **with** `due_all_day = true`
  (`migrations/20260921_calls_dropoff_key_box_{SANDBOX,PROD}.sql`: `boolean not null default
  false`, no RLS change). Only meaningful on a `dropping_off` row — `isKeyBox(call)` also
  requires the step, so a flag left behind when Follow up turns the row into a callback
  is never shown.
- **The time picker** (both the call window's `dropoffTimeOptions` and the Desk modal's
  `deskTimeOptions`) now reads: **Any time** (value `''`, the default for a new drop-off,
  all-day — this was "Morning (no time)") · **After hours · key drop box**
  (`KEY_BOX_VALUE`) · 7a–6p times · (call window only) Custom time…. Callbacks have no time
  picker and are unchanged. `dropoffTimeChoice(value)` is the one mapping from the picked
  value to `{ allDay, keyBox, hh, mm }`; both save paths use it.
- **Every drop-off save writes the flag** (true or false), so switching from the key box
  to "Any time" or a time clears it. Switching the call window's step chip clears it too.
  **Dragging a chip onto a timed slot clears it in the same write**
  (`reschedulePatch`); dragging onto the all-day strip keeps it.
- **Shown as:** 🔑 at the start of the calendar chip; a **🔑 Key box** pill next to the date
  on the Coming-in row; and `· 🔑 Key box` on the §10 line (Call Log + customer record).
  It's all-day, so it's late by the all-day rule — nothing else about overdue changes.
- **Runs ahead of the migration safely.** The board reads the column in its own top select
  tier (`CALL_COLS_KEYBOX`, `LOG_COLS_KEYBOX`) and sets `keyBoxColAvailable` from it; the
  call window checks `'dropoff_key_box' in card._call`. Without the column the key-box
  option isn't offered and `withKeyBox` leaves the column out of every write, so no save
  ever 400s on it. `api/desk-appointment.js` only writes the field when the body carries it.

## 6c. The calendar's view and same-time chips
- **The view:** `HOUR_PX = 44, DAY_START = 7, DAY_END = 18`. The grid is still **24 h**
  tall (a 6 pm or a custom 10:15 pm chip stays reachable by scrolling); only the box
  changes — `max-height = (DAY_END − DAY_START) × HOUR_PX + 24px` (one chip's height, so a
  6 pm chip isn't clipped at the edge), opened scrolled to 7 am. Before, the box was a
  fixed 520 px opened at 6 am (≈ 6 am–5:50 pm) and `DAY_END` was never used.
- **Same-time chips:** `layoutTimedChips(items)` groups a day's timed chips whose 30-min
  spans overlap (a chip is `min-height:22px` ≈ 30 min; grouping is transitive — 9:00, 9:20,
  9:40 are one group of three; exactly 30 min apart is not an overlap) and returns
  `{ call, i, n }`. `timedChip` gives chip i of n `left = i/n`, `width = 1/n` (`.is-split`
  tightens the padding, and a split chip shows the **name** only — the row gives the time — with
  "9:00 AM Name" as its tooltip). Before, every chip was `left:2px; right:2px`, so prod ids **31 + 35**
  (both Tue Aug 4, 9:00 AM) drew as one chip. Drag still hit-tests the **column**, so a
  narrower chip drops exactly where it did.
- All-day chips never overlapped (they stack in a flex column) and are unchanged.

## 6d. Who a Desk row is — `shared/desk-names.js`
Until 2026-09-22 a lane named a row **only** through `calls.customer_id`, and Recently
cleared never looked its customers up at all (the lookup took ids from the open rows only),
so on prod all 12 linked cleared rows, every "+Add" walk-in and every unlinked caller showed a
bare number. Now every lane, Recently cleared and the calendar chips use one resolver,
`deskName(call, { byId, byPhone, phoneLabel })`:

1. `customer_id` → that customer — **confirmed** (plain bold). Linked but not loaded → the
   number, never a phone guess over a human's link.
2. a **"+Add" row's typed name** (`cnam` on a row with a synthetic negative `ctm_call_id` —
   `isManualCall`, the marker `api/desk-appointment.js` sets) — **confirmed**.
3. the phone matches **exactly one** active customer → that name — **guess**.
4. **2+** customers → "N customers on this number" — **guess**; never picks one.
5. otherwise the formatted number (as before).

- **CTM caller-ID `cnam` is ignored** — 14 of 46 on prod are a city ("FORT MYERS   FL").
- **Archived / merged-away customers** (`CustomerArchive.isArchived`) are dropped from the
  phone index, so they are never the guess and never counted in N.
- A call a human marked **"not a customer"** (`not_a_customer_at`) is never guessed.
- **The data:** `CALL_COLS` gains `cnam, not_a_customer_at`. `deskLoad` looks up customers for
  `customerIdsToLoad(calls, cleared)` (open **and** cleared) and builds the phone index from
  the shared paginated `cdFetchAllCustomers` (cached in `custIdx`; not cached if that fetch
  isn't loaded yet) → `lastData.phoneIdx`.
- **How a guess looks:** grey italic + a small "?" (`.desk-name-guess`, tooltip "Matched by
  phone — not confirmed"), the number on the line under it; chips get `.is-guess` (italic
  grey) and a trailing "?". Confirm dialogs and the edit modal use the same text.
- **"Who is this?"** — tapping a guess (lanes and Recently cleared) opens `#deskGuess`:
  one guess → **Yes, that's <name>** · **Someone else…** · **Open customer page**; "N
  customers" → the N to pick from · **Someone else…**. Every link goes through the July 29
  `performAttach` (anon UPDATE via `CallAttach.attachCallPatch`, the open-RO re-check, the
  phone-learn plan) wrapped by `attachFromDesk`, which redraws the Desk from memory so the
  row turns confirmed without a reload. **Someone else…** opens the existing attach picker
  (`openAttach`, search all customers); **Open customer page** is `cdOpenCustomerById`
  (navigation only). A confirmed name or a bare number keeps its old tap (open by phone).
- The sticky "Recovered" banner (Coming-in only) gets `box-shadow:0 0 0 6px #E1F5EE` so an
  overdue row's red edge no longer shows through its rounded corners while the lane scrolls.

## 7. Editing / re-routing a Desk item, and adding one by hand
Nothing on the Desk depends on the live call popup any more — an item can be fixed or
created directly. One modal (`#deskEdit`, `openDeskEdit(mode, opts)`) does both, with the
**same lane+weekday outcome echo** as the call window.

- **Edit / re-route** — the **Edit** button on a Callbacks or Coming-in row opens the
  modal on that item. It can **change the type** (Callback ⇄ Drop-off = `quoted_callback`
  ⇄ `dropping_off`) and the **date/time**. Save goes through **`api/calls.js` `edit`**
  (security slice 3 (a)2): `{ next_step, due_at, due_all_day, dropoff_key_box }` built by
  `withKeyBox` on the server — the key box only on an all-day drop-off, §6b — it never touches `resolved_at`, so the
  item stays on the Desk (invariant held). This is how a mis-bucketed callback becomes a
  drop-off on the calendar. (Dragging a chip still reschedules date/time only.)
- **Manual add** — the **`+ Add`** button (calendar header) **or clicking an empty
  calendar slot** opens the modal in add mode: enter a phone (+ optional name), pick type
  + date/time. A unique phone→customer match links `customer_id` (so the Desk shows the
  name); otherwise it's a phone-only walk-in. Save **POSTs `api/desk-appointment`** (§8).
  An empty all-day cell pre-fills that date; an empty timed column pre-fills date + the
  snapped time. A click that trails a drag-drop is suppressed (`justDragged`).
- The echo makes the destination lane + weekday visible before saving here too, so an
  edit/add can't silently land in the wrong lane or on the wrong day.

## 8. The manual-add endpoint — `api/desk-appointment.js`
Because anon can't INSERT into `calls` (§1), a manual add runs server-side with the
service-role key (same posture as `api/recording-assign.js`).

**A + Add row never rings.** It is a new `calls` row, so the tray's realtime INSERT listener
sees it — but its `ctm_call_id` is negative (`syntheticCtmId`), and the tray only rings for a
real CTM call (`isRealCall`, [[inbox-calls]] §2). It shows on the Desk / calendar only.

**SIGNED-IN EMPLOYEES ONLY since 2026-09-17 (Security Phase 3).** The first thing the handler
does — before the body is parsed — is `requireUser(req)` (`api/_lib/require-user.js`): the
caller's `Authorization: Bearer <access_token>` must be a live Supabase session **whose
`auth.uid()` maps to an `employees` row with `active = true`**, else a flat
`401 {error:'unauthorized'}`. A valid session alone is not enough — the KiKi app shares this
project's `auth.users`. The board sends the token via `cdAuthFetch` (`shared/auth-fetch.js`),
which also logs any rejection instead of swallowing it. Before this, the method check was the
only guard: anyone on the internet could call it and it would run with the service-role key.

- `POST { next_step, due_at, due_all_day, dropoff_key_box?, caller_bare, caller_formatted,
  cnam, customer_id, note, noted_by_name }` → inserts one `calls` row, returns
  `{ appointment }`. `dropoff_key_box` is optional and only written when present (the board
  omits it on a DB without the column); it must be a boolean, is forced false on a callback,
  and is refused with `due_all_day: false` (§6b).
- `next_step` is limited to `quoted_callback | dropping_off` (the only schedulable steps);
  requires a 10-digit phone **or** a `customer_id`; `due_at` must be a valid timestamp.
- Sets the walk-in markers from §1: a synthetic negative `ctm_call_id` (regenerated once
  on the unlikely UNIQUE collision) and `started_at = null`. `resolved_at` stays null.
- Pure helpers `parseApptBody` / `syntheticCtmId` are unit-tested in
  `api/desk-appointment.test.js`. **Prod-only:** the endpoint runs on Vercel, so manual
  add does not work under a bare static preview; since slice 3 (a)2 edit/re-route goes through
  `api/calls.js` too, so neither works under a bare static preview.

## 9. Finishing with a Desk item — `shared/desk-outcomes.js`
Until 2026-09-20 there was exactly one way: **"Done" → `resolved_at`**, no confirm, no undo,
no record of what happened. It was on both lanes *and* in the call window, and the audit
above shows what that cost. The Desk is where **leads** live — people who called but have no
RO yet — so "finished with it" is four different things, and only three end the lead.

### 9a. The four outcomes
The Coming-in row carries: **Arrived · Reschedule · Not coming · Follow up**.

| Button | Stored `outcome` | Clears it? | What it does |
|---|---|---|---|
| Arrived | `arrived` | yes | the car showed up |
| Reschedule | *(none)* | **no** | not an outcome — nothing happened yet. Reuses the §7 Edit modal, changes the date, item stays on Coming in |
| Not coming | `not_coming` | yes | modal asks **why** (free text, optional) |
| Follow up | `follow_up` | **no** | modal asks for a **call-back date** (default +14 d, editable) + why |
| Callbacks "Done" | `called` | yes | I made the call |

**The buttons say WHAT HAPPENED; the note says WHY.** The first cut used
`fixed_elsewhere` / `not_now`, which each name ONE reason — the first car that fixed itself
or customer who sold theirs would have been filed under "fixed elsewhere" and every report
would have repeated it. Reasons can't be enumerated, so they're free text; four buttons that
describe the *outcome* can stay four buttons forever. A test fails if a value ever names a
reason again.

**`follow_up` is the one that does not resolve, and that is the point.** A lead who can't do
it this month is still a lead. The row STAYS OPEN and moves lanes: `next_step` →
`quoted_callback`, `due_at` → the call-back date, `outcome_prev_due_at` keeps the drop-off
date they missed, `resolved_at` is never touched. The Callbacks row then shows
`callbackReason()` — *"Couldn't make Fri, Sep 18 drop-off — no money till the 1st"* — so a
parked lead never looks like an ordinary callback. Resolving it would be the old bug in a
new coat.

### 9b. The confirm
Clearing an item whose **day is still ahead** asks first: *"This clears &lt;who&gt;'s
&lt;date&gt; drop-off from the Desk. Sure?"* That is the shape of every real mis-click found
(id 755: cleared Sep 8, due Sep 28).

Deliberately **strictly-future-day**, not "any moment still ahead". A car arriving later
today is the normal flow; prompting on every ordinary arrival trains people to click
through, which is how a confirm stops working the day it matters. For `arrived`/`called` it
fires on the button; for `not_coming` it fires on the modal's **Save**, so cancelling the
modal costs nobody a dialog. `follow_up` never asks — it clears nothing.

### 9c. Undo — "Recently cleared"
A collapsed panel under the calendar, hidden when empty. It lists resolved rows that are
**cleared in the last 30 days OR still due ahead however long ago they were cleared** — the
second half is the only reason a Sep-28 drop-off cleared on Sep 8 is reachable at all. Each
row shows who cleared it, when, which outcome and any note, with one **↩ Undo**.

`undoPatch()` nulls `resolved_at`, `resolved_by_name`, `outcome`, `outcome_note` — and
nothing else. A clearing outcome never changed `next_step`/`due_at`, so the row comes back
exactly where it was. `outcome_prev_due_at` is deliberately **kept**: only `follow_up` sets
it, and a row later cleared from Callbacks should return still knowing why it is there.

A row cleared before outcomes existed reads **"Done (before outcomes)"** rather than
inventing a reason for it.

### 9d. Data — three nullable columns on `calls`
`outcome` (CHECK: `arrived | not_coming | follow_up | called`), `outcome_note`,
`outcome_prev_due_at`, plus a partial index on `resolved_at` for the cleared list.
**No new table** — a Desk appointment IS a calls row (§1). **No backfill**, **no RLS
change**. The writes went through the Desk's anon UPDATE until security slice 3 (a)2; now
through `api/calls.js` (`outcome` / `undo` / `done`), same patches (`outcomePatch` /
`undoPatch`), built on the server. Follow up's `outcome_prev_due_at` is read from the ROW.

- `migrations/20260920_calls_outcome_{SANDBOX,PROD}.sql` — **either order is safe.**
  `deskLoad` tries `CALL_COLS_OUTCOME` and falls back to `CALL_COLS` on 42703 (the tier
  trick `logLoad` uses), showing the old single "Done" until the columns exist.
- `migrations/20260920_calls_outcome_rename_SANDBOX.sql` — **sandbox only, and order
  matters.** The sandbox ran the first draft's values; prod never did, so the `_PROD` file
  was edited in place and has no twin. A CHECK mismatch is 23514, not 42703, so the fallback
  does **not** cover it: the renamed board's writes fail loudly until this runs.

### 9e. Status — LIVE
Verified end-to-end on `test.*` on 2026-09-20 (ZZ Test rows 286–292, phones `(999) 555-000x`):
all four outcomes and their DB rows, the confirm and its Cancel branch, the parked-lead reason
line, Recently cleared, Undo (before *and* after the value rename), and the served page carrying
no `cc-done`.

**Shipped to prod at `1aeb2ee`** (2026-09-20 ~08:20 ET), DB first. Read-only check on `board.*`
straight after: 24 Coming-in rows, all four buttons on **one line** in the 351px lane, the new
banner wording, no `cc-done` anywhere, and **Recently cleared listing 16 rows — including
`(863) 517-1163` (OMAR MADRID), drop-off Mon Sep 28, "cleared 11 days ago by MANNY PAGAN", with
a working Undo.** That is the row this whole slice existed to make recoverable; Cris undoes it
himself.

Every pre-existing resolved row reads **"Done (before outcomes)"**, as intended — nothing was
backfilled with a guess.

## 10. The appointment OUTSIDE the Desk — `shared/call-appointment.js`
A call's Desk appointment (`due_at`) and what came of it (`outcome` / `resolved_at`) used to
show only on the Desk. Two other screens now draw it, in the **Desk's own words**:

- **What the line says.** `dueLine(call, dueLabel)` → `→ Drop-off Tue, Sep 23 · 9:00 AM`, or
  `→ Call back Tue, Sep 23` for `quoted_callback`; all-day = the date only, with the calendar's
  rule (only `due_all_day === false` is timed). A key-box drop-off (§6b) reads
  `→ Drop-off Tue, Sep 23 · 🔑 Key box`; the Call Log reads the flag in its top tier
  `LOG_COLS_KEYBOX`, the customer record already has it via `select('*')`. `outcomeLine(call, clearedLabel)` →
  `✓ Car arrived · by <resolved_by_name>` / `✓ Not coming` / `✓ Called`, and
  `✓ Done (before outcomes)` for a row cleared before outcomes existed. `follow_up` never
  resolves (§9), so it shows as `Follow up later` with no tick. Undo nulls the outcome
  fields, so an undone row shows no outcome line.
- **No second formatter.** The module only composes. The date is the Desk's `dueLabel`
  (exposed to the other IIFE as `window.cdDueLabel`); the outcome wording is
  `DeskOutcomes.clearedLabel` — the same words **Recently cleared** uses.
- **Call Log (`logRender`).** `LOG_COLS` now carries `due_at, due_all_day`; a fourth select
  tier `LOG_COLS_OUTCOME` (= `LOG_COLS_AUTO` + `outcome, resolved_at, resolved_by_name`) is
  tried first and falls back to `LOG_COLS_AUTO` on a missing column. The line
  (`.log-appt`) sits under the disposition pill. **Real calls only:** the log still filters
  on `started_at`, so manual "+Add" rows (§8, `started_at` NULL) stay out of it — on purpose,
  decided 2026-09-21; the Front Desk redesign's History view will own those.
- **Customer record (`callEntryHtml`).** The same line (`.cust-tl-appt`) under the entry's top
  row; the row is already `select('*')`, so no query changed. A manual row
  (`isManualCall`: synthetic negative `ctm_call_id`) carries an **Added on the Desk** tag.
- **The "when" rule.** `callWhen(call)` = `started_at`, else `created_at` — a manual row never
  rang. Every customer-record read of a call's time goes through it (`cdCallWhen`): the
  entry's time, `timelineHtml`'s sort, `buildRecordingCalls`' sort (`compareCallWhen`),
  `vehActivity`, `custLastActivity`. So a manual row shows when it was added and sorts
  there, instead of "—" at the top.
- Pure, no DOM → `shared/call-appointment.test.js`, incl. board-wiring assertions that the
  customer-record path never reads `started_at` raw.

## Known gaps & open questions (as of 2026-09-22)
- **"Someone else…" can't create a new customer** (§6d). The only create path is inside the
  New-RO wizard, which goes on to a vehicle and never links a call; building a Desk create
  would be a new customer-insert path, so it was left out. Today: search existing only.
- After a Desk confirm to a customer who doesn't have that number, the "also save this
  number?" question is only drawn in the **Call Log** (pendingLearn); the attach itself is
  unconditional and done.
- The four chips are one undifferentiated wrap row; "Quoted — will call back" and
  "Dropping off" are adjacent and easy to mis-tap. The echo now catches the *result*;
  visually separating "an appointment" from "a reminder" is a possible next step.
- ~~"Mark done" is a one-click, no-confirm, no-undo delete~~ — **fixed in §9 and live on prod
  at `1aeb2ee`** (four outcomes, a confirm on future-dated clears, and Recently cleared / Undo).
- **A manual "+Add" appointment is still absent from the Call Log** (by decision, §10) — it
  shows on the Desk and on the customer record only. The RO header, New-RO wizard and the
  RO's Call History panel still show no appointment date (out of scope 2026-09-21).
- ~~Two timed chips in the same slot drew as one; the box opened at 6 am and `DAY_END` was
  unused~~ — **fixed in §6c** (side by side; 7 am–6 pm view on the same 24 h grid).
- The time pickers still offer **7a–6p** while the shop is open 8–5; left as is on purpose
  (a key-box drop-off covers "after hours").

## Where it lives in the code
- **Desk names (§6d):** `shared/desk-names.js` (`deskName`, `buildPhoneIndex`,
  `customerIdsToLoad`, `isGuess`, `textLabel`, `GUESS_TOOLTIP`, +`.test.js`), loaded as
  `window.DeskNames`; `advisor-board.html` — `CALL_COLS`, `deskLoad` (lookup + `phoneIdx`),
  `deskNameOf` / `deskNameHtml` / `customerLabel`, `chipFlags`, `#deskGuess` +
  `openGuessBox` / `attachFromDesk`, `cdOpenCustomerById`, `.desk-name-guess` CSS.
- **Key box + calendar layout (§6b/§6c):** `shared/desk-appointments.js` (`layoutTimedChips`,
  `isKeyBox`, `dropoffTimeChoice`, `withKeyBox`, `reschedulePatch`, `KEY_BOX_*`,
  `ANY_TIME_OPTION`, +`.test.js`); `advisor-board.html` — `DAY_START`/`DAY_END`,
  `renderCalendar`, `timedChip`/`calChip`, `rescheduleCall`, `CALL_COLS_KEYBOX` /
  `keyBoxColAvailable`, `deskTimeOptions`/`deskEditSave`, `LOG_COLS_KEYBOX`, and the call
  window's `dropoffTimeOptions` + drop-off save; `api/desk-appointment.js` (`parseApptBody`);
  `migrations/20260921_calls_dropoff_key_box_{SANDBOX,PROD}.sql`.
- **Appointment outside the Desk (§10):** `shared/call-appointment.js` (`dueLine`,
  `outcomeLine`, `isManualCall`, `callWhen`, `compareCallWhen`, +`.test.js`), loaded as
  `window.CallAppointment`; `advisor-board.html` — `LOG_COLS` / `LOG_COLS_OUTCOME` +
  `logRender` (Desk IIFE), `window.cdDueLabel`, `cdCallWhen` + `callEntryHtml`
  (customer-record IIFE); `shared/customer-record.js` `buildRecordingCalls` sort.
- **Confirm-before-learning (§2c):** decision logic in `shared/call-attach.js` —
  `wouldLearnPhone`, `countForeignCalls`, `phoneLearnDefaultYes`, `phoneLearnDeclineKey`,
  `isPhoneLearnDeclined`, `rememberPhoneLearnDecline` (tested in `shared/call-attach.test.js`).
  Board side in the `desk` IIFE of `advisor-board.html`: `pendingLearn`, `planPhoneLearn`,
  `answerPhoneLearn`, the hoisted `setSecondaryIfNull`, `loadLearnDeclines` /
  `rememberLearnDecline` (localStorage `cdPhoneLearnDeclined`), the `.log-learn` block in the
  row renderer, and the `learn-yes` / `learn-no` cases in the `.log-act` handler. CSS
  `.log-learn*`.
- Call window: `advisor-board.html` — `callerCard` IIFE (`formShellHtml`, `renderWhen`,
  `updateEcho`, `wireForm`, `saveNote`, `resolveCallCard`, `handleNewCall`; the realtime
  `subscribeCalls` + `backfillRecentCalls` + the `window.cdCallsHealthy /
  cdResubscribeCalls / cdBackfillCalls` hooks at the bottom). Date helpers `toDueAt` /
  `dueAtToDateStr` / `addDaysStr` in the same IIFE.
- Connection-health for the card channel: `initRefreshSafetyNet` → `ensureCallsHealth`
  (advisor-board.html, ~line 2853) — the only place the global calls channel is health-
  checked/re-subscribed + backfilled.
- Desk: `advisor-board.html` — `desk` IIFE (`deskLoad`, `deskRender`, `renderCalendar`,
  `calendarFeed`, `chipFlags`, `resolveCall`, `rescheduleCall`); `dueLabel` /
  `startOfToday` here, and `isOverdue`, which delegates to the module below.
- **Outcomes / confirm / undo (§9):** `shared/desk-outcomes.js` — `OUTCOMES`,
  `OUTCOME_LABEL`/`_SHORT`/`_NOTE_PLACEHOLDER`, `clearsItem`, `outcomePatch`, `undoPatch`,
  `needsConfirm`, `confirmMessage`, `recentlyCleared`, `clearedLabel`, `callbackReason`,
  `defaultCallbackDate` (+ `shared/desk-outcomes.test.js`). ESM →
  `window.DeskOutcomes`. Board side in the `desk` IIFE: `applyOutcome`, `undoCleared`,
  `openOutcomeModal` / `saveNotNow`, `renderCleared`, the `#deskClearedCard` panel and the
  `#deskNotNow` modal; CSS `.desk-row-outcomes`, `.desk-btn.warn/.hold`, `.desk-row-why`,
  `.desk-cleared-*`. Schema: `migrations/20260920_calls_outcome_{SANDBOX,PROD}.sql` +
  `_rename_SANDBOX.sql`.
- **Display rules (§6a):** `shared/desk-appointments.js` — `isOverdueDue`, `splitComingIn`,
  `comingInOrder`, `calendarItems`, `overdueCount`, `isRecovered`, `recoveryNoticeVisible`,
  `showRecoveryBanner`, and the `RECOVERED_*` constants (+ `shared/desk-appointments.test.js`).
  Loaded as ESM → `window.DeskAppointments`; reuses `shopToday` / `isNewBadgeVisible` from
  `shared/new-badge.js`. CSS `.desk-row.is-overdue` / `.is-undated`, `.desk-chip.is-past`,
  `.desk-recovered-banner`, `.desk-recovered-tag`.
- Edit / re-route + manual-add modal: `advisor-board.html` `desk` IIFE
  (`openDeskEdit` / `deskEditSave` / `deskEditEcho` / `deskTimeOptions`, the `#deskEdit`
  markup, the lane `data-edit` buttons, `#deskCalAdd`, and the empty-slot click wiring in
  `wireCalendarDrag`).
- Manual-add endpoint: `api/desk-appointment.js` (+ `api/desk-appointment.test.js`).
- Schema: `migrations/20260728_calls.sql`, `_calls_notes.sql`, `_calls_resolved.sql`.

## Session change log
- **2026-09-25** — (staging) §8: a + Add row never rings in the tray (`isRealCall`, [[inbox-calls]] §2).
- **2026-09-25** — security slice 3 (a)2 **shipped to prod**: fast-forward `8b8f8af..44fca0e` (code = `254dc9c`; `44fca0e` = docs-only on top). www / board. / apex `/api/version` = `44fca0e` (www flipped back to the old SHA once while the domains switched, then steady); `advisor-board.html` (+ `shared/desk-outcomes.test.js`) byte-identical to `254dc9c`, docs to `44fca0e`, on all three; CLAUDE.md 404; an unauthenticated Desk `outcome` → 401 on all three. Prod read-only (not signed in, nothing written): page loads, tray folded, no console errors. Cris checked Follow up by hand on test.* first (Mon Oct 12 + reason on (239) 634-0703 — both saved). One real Desk action on prod: Cris.
- **2026-09-25** — security slice 3 (a)2 driven signed in on test.* at `254dc9c` (ZZ Test Advisor, real clicks; test rows 301–303 made with + Add). **Arrived** on 301 (today) → 200, `outcome arrived`, resolved by ZZ Test Advisor, off Coming in; reload → in Recently cleared. **Follow up** on 302 (Sat Sep 26 drop-off) with reason "waiting on insurance" → 200, moved to Callbacks, `due_at` Oct 9 (the dialog's default — the typed date didn't take in the date control), `outcome_prev_due_at` Sep 26 from the row, not cleared; reload → on Callbacks. **Undo** 301 → 200, the row identical to before Arrived; reload → back on Coming in. **Done** on callback 297 (TEST TRAYCALL, due today, no confirm) → 200, `outcome called`, resolved by ZZ Test Advisor; reload → in Recently cleared. **Edit** 303 (Sun Sep 27 10:00) → after-hours key drop box → 200, all-day + `dropoff_key_box true`; reload → 🔑 chip on Sun's all-day row. **Calendar drag** of that chip to Sat Sep 26 ~10 AM → 200, `due_at` Sat 10:15, `due_all_day false`, `dropoff_key_box false` in the same write; reload → "10:15 AM TEST DESK EDIT" on Saturday. Left on the sandbox: 301 (drop-off today), 302 (callback Oct 9), 303 (drop-off Sat 10:15), 297 cleared (called).
- **2026-09-25** — (staging) security slice 3 (a)2: the six Desk writers go through `api/calls.js` (`outcome` / `undo` / `done` / `edit` / `reschedule`), patches built on the server with the same shared rules; a clear only on an open row (409); failures shown, never faked; §1, §7, §8, §9d.
- **2026-09-25** — security slice 3 (a)1 **shipped to prod** ([[inbox-calls]] change log): fast-forward `c51dc83..969bdec` (code = `bd78d76`; `969bdec` = docs-only on top). www / board. / apex `/api/version` = `969bdec` (~30 s); `advisor-board.html` (+ the two static tests) byte-identical to `bd78d76`, docs to `969bdec`, on all three; CLAUDE.md 404; `api/calls` answers an unauthenticated POST with 401 on all three. Prod read-only (not signed in, nothing written): page loads, tray folded, `cdCallsWrite` present, no console errors. Live test call + note: Cris, on prod.
- **2026-09-25** — (staging) security slice 3 step (a)1: §1 + §5 — the card's writes go through `api/calls.js`; Close waits for the save.
- **2026-09-24** — **shipped to prod** as `47bdc15` (fast-forward `1682236..47bdc15`, Cris's OK after testing on test.* as ZZ Test Advisor). www / board. / apex `/api/version` = `47bdc15` (steady); the 12 changed served files byte-identical on all three; CLAUDE.md 404. Prod read-only (pane not signed in, nothing written, no RO opened): the tray loaded FOLDED (strip, board padded 48 px), no `#callCardStack`, no floating `.call-card` anywhere, f badge "!" (the not-signed-in state), 📞 grey. Before the ship, the two glance fixes checked on test.* with dry-run rings: JOSE RAMIREZ → no Last visit / no Heads up rows (his only RO is in the shop); KEVIN CRUZ → Last visit "RO #6032 · Sep 19", no Heads up.
- **2026-09-24** — calls into the Inbox tray, slice 1 (staging): the card lives inside the tray (no floating stack); chips Call back · Coming in · Done (coming), old two hidden unless set; recording + "coming" Attach/Start RO/Not a customer on the card; Close / × refuse an un-noted call; backfill = today's untouched calls (25) and runs on page load; `loadDetail` also reads each RO's `closed_at` + vehicle (for the tray's glance). Writes unchanged. [[inbox-calls]].
- 2026-09-23 — §6-log added: `window.cdDeskOpenLogAt(when, callId)` + `data-log-call` on log rows + `.log-row-hl`, for the top-bar search's unattached call-note results. Nothing else in the call log changed.
- 2026-09-22 — §6d shipped to prod at `62bbd73` (fast-forward `d2ac603..62bbd73`, no migration); all 5 changed files byte-identical to git on www, board.* and apex.
- 2026-09-22 — **§6d added:** one name resolver for every lane, Recently cleared and the chips (link → "+Add" typed name → phone guess → number); Recently cleared gets its own customer lookup; guesses are grey italic "?" and open a "Who is this?" box that confirms via the July 29 attach path; red-sliver banner fix. No migration, no new endpoint.
- 2026-09-21 — §6b/§6c shipped to prod at `83826ed` (fast-forward `28c49bd..83826ed`) after the PROD migration (0 rows set, 896 calls); the 3 changed front-end files byte-identical to git on www, board.* and apex. Sandbox test row id 293 (ZZ KEYBOX TEST) left in place on purpose.
- 2026-09-21 — **§6b + §6c added:** key drop box (`calls.dropoff_key_box`, picker option, 🔑 on chip / Coming-in / §10 line, cleared on drag-to-timed); "Morning (no time)" → "Any time"; same-time chips side by side (`layoutTimedChips`); calendar view 7 am–6 pm via `DAY_START`/`DAY_END` on the unchanged 24 h grid. Sandbox migration run by Cris.
- 2026-09-21 — §10 shipped to prod at `6733056` (fast-forward `57763fb..6733056`); the 3 changed files byte-identical to git on www, board.* and apex.
- 2026-09-21 — **§10 added:** the Call Log and the customer record draw a call's due + outcome line (Desk wording, `shared/call-appointment.js`); customer-record call time falls back `started_at` → `created_at`; manual rows tagged. Manual rows stay out of the Call Log by decision. No migration.
- 2026-09-21 — Shipped to prod at `e74136f` (fast-forward `bbe6203..e74136f`). `advisor-board.html` byte-identical to git on www, board.* and apex.
- 2026-09-21 — Desk lanes scroll inside their own box (~6 rows, `.desk-lane-body` max-height); "recovered" banner sticky. CSS only, all three lanes (§6).
- 2026-09-20 — **Shipped to prod at `1aeb2ee`** (fast-forward `2eb77b1..1aeb2ee`, no Promote,
  after `20260920_calls_outcome_PROD.sql`). `advisor-board.html` + `shared/desk-outcomes.js` +
  `shared/desk-appointments.js` byte-identical to git on `www` and `board.*`. Prod read-only
  check: 24 Coming-in rows, buttons on one line, Omar (id 755) listed in Recently cleared with
  Undo. §9e flipped from "not shipped" to live.
- 2026-09-20 — **§9 added; §5 rewritten; §6 bullet replaced.** Four outcomes replace the one
  destructive "Done"; "Mark done" removed from the call window; confirm on future-dated
  clears; "Recently cleared" undo. New `shared/desk-outcomes.js` (+ tests, 791 total) and
  three nullable `calls` columns. Values renamed `fixed_elsewhere`/`not_now` →
  `not_coming`/`follow_up` the same day, so the buttons name the outcome and the note the
  reason. Verified on `test.*` at `42a30b2`/`2c67b41`. **Not on prod.**
- 2026-09-20 — Shipped to prod at `cde6aa6` (fast-forward `8a49358..cde6aa6`, no Promote).
  `advisor-board.html` + `shared/desk-appointments.js` + `shared/new-badge.js` byte-identical to
  git on `www` and `board.*`. Prod numbers matched the 2026-09-20 audit exactly: 16 overdue,
  3 undated. **Known nit:** a drop-off due *today* is tagged "recovered" although the old filter
  always showed it — the cutoff is `due_at < RECOVERED_CUTOFF`, not `< today`. One row
  (2026-09-20), cosmetic, self-expires 2026-10-05.
- 2026-09-20 — **§6a added; §6 rewritten.** Coming-in now shows overdue (top, oldest first)
  and undated drop-offs, the calendar is fed every dated drop-off so past weeks draw, and
  the overdue badge counts drop-offs. New `shared/desk-appointments.js` (+ 26 tests) holds
  the rules; the board's `isOverdue` delegates to it. Recovered-row tag + lane banner,
  self-expiring on the [[new-badge]] date rule. Display only — no schema, no new write
  path, `resolved_at` untouched. Known gaps rewritten from the 2026-09-20 prod audit
  (Mark-done mis-clicks, the unrecoverable date, same-slot chip overlap, the unused
  `DAY_END`).
- 2026-09-17 — §8: manual add now requires a signed-in active employee (`api/_lib/require-user.js`); the advisor board sends its session token through `cdAuthFetch`. The anon-UPDATE edit path is unchanged.
- 2026-08-18 — **Confirm before learning a phone number** (§2c). Attaching no longer performs a
  silent second write to `customers`: when a number would be learned the row shows an inline
  question, defaulted to NO when other calls from that number aren't this customer's. The attach
  itself is unconditional and runs first (`learned_phone` false), the evidence lookup runs
  concurrently with it, and a yes then does the same atomic `setSecondaryIfNull` + stamps
  `learned_phone`. Declines are remembered per-browser in `localStorage`. Verified in-browser
  with every write intercepted: default-NO case (5 foreign calls, warning shown), default-YES
  case, decline → no `customers` write and no re-ask on the next attach, accept → atomic write
  then `learned_phone: true`.
- 2026-08-18 — **Decoupled `ro_id` from `next_step`** (§2, §2b, §3). The RO picker moved out
  of the `checking_on_car` branch of `renderWhen` into its own persistent `.cc-filed` row
  (`renderFiledRo`), shown under every disposition and under none; the chip handler no longer
  clears `ro_id`. A manual pick now also clears the auto-attach tags. Nothing else on the card
  changed. See [[call-auto-attach]] §7.
- 2026-07-30 — Documented the subsystem while adding three fixes after Josh's mis-routed
  drop-off: the outcome echo (§4), Close-vs-Mark-done (§5), and clearing the date on a
  chip switch (§3).
- 2026-07-30 — Added Desk **edit / re-route** (change type + date/time from the card;
  anon UPDATE) and **manual add** (`+ Add` / empty calendar slot; walk-in with no call,
  via `api/desk-appointment.js`). Documented the walk-in single-row representation (§1)
  and the endpoint (§8). Resolves the "no way to fix a mis-bucketed item / no manual add"
  gap.
- 2026-07-30 — Fixed **incoming cards silently stopping after a dropped socket** (§2a).
  The global `advisor-board-calls-live` channel was never in the connection-health net;
  now `ensureCallsHealth` re-subscribes it on focus/visibility/60s and backfills recent
  untouched calls (bounded 15 min / 5 max, dedup + dismissed-tracking). Not a regression
  from the day's earlier commits — a pre-existing gap.
