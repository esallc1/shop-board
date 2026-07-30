# How the call window & advisor Desk are wired

> Doc: `/docs/wiring/call-window-desk.md`
> Last updated: 2026-07-30 — verified vs commit `f449c1c`
> Status: ✅ verified vs commit `f449c1c` — checked against `advisor-board.html` (the `callerCard` and `desk` IIFEs), `api/desk-appointment.js`, and the `calls` migrations.

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

**Walk-in / manual appointment (no call).** The same single-row model represents an
appointment that never came in as a call — a `calls` row marked "not a real call" by two
fields: `ctm_call_id` = a **synthetic negative id** (real CTM ids are positive, so it
never collides and is trivially identifiable), and `started_at` = **null** (so it never
appears in the day's Call Log, which queries by `started_at` — it lives only on the Desk
via `next_step` + `due_at`). Written by `api/desk-appointment.js` (§8).

## 2. The call window (the popup) — `callerCard` IIFE
- Opens on a live inbound call (Supabase realtime **INSERT** on `calls`), one card per
  `ctm_call_id`. Test hook: `window.cdHandleTestCall(call)`.
- The card **autosaves** to the `calls` row as you go (`saveNote` — note on a 2s debounce
  + blur; every other field immediately). The first save stamps `noted_at/noted_by_name`.
- **"What happens next"** is four single-select chips (`NEXT_STEPS`):

  | Chip | `next_step` | Date UI | Lands on the Desk as |
  |---|---|---|---|
  | Quoted — will call back | `quoted_callback` | quick buttons (Tomorrow / In 3 days / Next week) + date; all-day | **Callbacks** lane |
  | Dropping off | `dropping_off` | date + optional time (Morning = all-day) | **Coming in** lane + **drop-off calendar** |
  | Checking on their car | `checking_on_car` | RO picker (`ro_id`), no date | (not a Desk lane) |
  | Price shopper | `price_shopper` | none | (not a Desk lane) |

- **All-day dates** are stored as **noon local** (`toDueAt(date, null)` → `new Date(y,m-1,d,12,0,0)`),
  so the calendar date can't slip a day across a timezone. A specific drop-off time sets
  `due_all_day=false`.

## 3. Switching chips clears the date (no stale carryover)
A chip switch **always** resets the date: the handler writes
`{ next_step, due_at: null, due_all_day: true }` (and clears `ro_id` for every step
except `checking_on_car`). This exists because a date entered under one step used to
ride across into the next — a callback date silently became a drop-off date. After a
switch the advisor re-picks the date from scratch.

## 4. The outcome echo (guardrail)
Under the chips, `.cc-echo` (via `updateEcho`) states **the lane + the weekday** the
moment a step + date are chosen — e.g. `→ Coming in: drop-off Tue, Aug 4 · on the
schedule` (blue) or `→ Callback: Thu, Jul 30` (purple); a "pick a date" prompt until a
date is set; hidden for `checking_on_car` / `price_shopper`. The **weekday** is the
point — it makes a wrong lane or a wrong date (e.g. "Thu, Jul 30" when Tuesday was
meant) visible **before** the card is closed.

## 5. Closing vs resolving (two distinct actions)
- **Close** (`.cc-close`) — dismiss the popup **without resolving**. A callback/drop-off
  stays on the Desk (`resolved_at` null) so it can't fall off the radar. This is the
  everyday action after scheduling something for later, and is the prominent/rightmost
  button so a habitual tap never accidentally resolves a future item.
- **Mark done** (`.cc-done`) — the callback/drop-off is actually complete: sets
  `resolved_at` + `resolved_by_name` (via `resolveCallCard`, mirroring the Desk's
  `resolveCall`), then closes. Only shown for an **unresolved** callback/drop-off.
- Invariant: a customer never *leaves the advisor's view while unresolved* — either it's
  resolved, or it's still visible on the Desk.

## 6. The Desk — `desk` IIFE
- `deskLoad` reads `calls` where `next_step in ('quoted_callback','dropping_off')`
  **AND `resolved_at is null`**, ordered by `due_at` asc.
- **Lanes:** **Callbacks** = `quoted_callback`; **Coming in** = `dropping_off` with
  `due_at >= today`; **Declined estimates** = `repair_orders.declined_at` (its own
  restore lifecycle, *not* `resolved_at`).
- **Drop-off calendar:** `renderCalendar(comingIn)` — a week grid of `dropping_off`
  rows with `due_at` today-onward; chips are drag-to-reschedule (`rescheduleCall`).
- **Desk row "Done"** (`data-done` → `resolveCall`) sets `resolved_at` — same write as
  the card's "Mark done".

## 7. Editing / re-routing a Desk item, and adding one by hand
Nothing on the Desk depends on the live call popup any more — an item can be fixed or
created directly. One modal (`#deskEdit`, `openDeskEdit(mode, opts)`) does both, with the
**same lane+weekday outcome echo** as the call window.

- **Edit / re-route** — the **Edit** button on a Callbacks or Coming-in row opens the
  modal on that item. It can **change the type** (Callback ⇄ Drop-off = `quoted_callback`
  ⇄ `dropping_off`) and the **date/time**. Save is an **anon UPDATE**
  (`update({ next_step, due_at, due_all_day })`) — it never touches `resolved_at`, so the
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
- `POST { next_step, due_at, due_all_day, caller_bare, caller_formatted, cnam,
  customer_id, note, noted_by_name }` → inserts one `calls` row, returns `{ appointment }`.
- `next_step` is limited to `quoted_callback | dropping_off` (the only schedulable steps);
  requires a 10-digit phone **or** a `customer_id`; `due_at` must be a valid timestamp.
- Sets the walk-in markers from §1: a synthetic negative `ctm_call_id` (regenerated once
  on the unlikely UNIQUE collision) and `started_at = null`. `resolved_at` stays null.
- Pure helpers `parseApptBody` / `syntheticCtmId` are unit-tested in
  `api/desk-appointment.test.js`. **Prod-only:** the endpoint runs on Vercel, so manual
  add does not work under a bare static preview; edit/re-route (anon UPDATE) works anywhere.

## Known gaps & open questions (as of 2026-07-30)
- The four chips are one undifferentiated wrap row; "Quoted — will call back" and
  "Dropping off" are adjacent and easy to mis-tap. The echo now catches the *result*;
  visually separating "an appointment" from "a reminder" is a possible next step.
- "Mark done" on a **future**-dated drop-off resolves it immediately with no confirm.
  Low-risk (Close is the prominent action), but a "this is scheduled for <date> — mark
  done anyway?" confirm is an option if it ever bites.

## Where it lives in the code
- Call window: `advisor-board.html` — `callerCard` IIFE (`formShellHtml`, `renderWhen`,
  `updateEcho`, `wireForm`, `saveNote`, `resolveCallCard`; realtime subscribe at the
  bottom). Date helpers `toDueAt` / `dueAtToDateStr` / `addDaysStr` in the same IIFE.
- Desk: `advisor-board.html` — `desk` IIFE (`deskLoad`, `deskRender`, `renderCalendar`,
  `resolveCall`, `rescheduleCall`); `dueLabel` / `isOverdue` / `startOfToday` here.
- Edit / re-route + manual-add modal: `advisor-board.html` `desk` IIFE
  (`openDeskEdit` / `deskEditSave` / `deskEditEcho` / `deskTimeOptions`, the `#deskEdit`
  markup, the lane `data-edit` buttons, `#deskCalAdd`, and the empty-slot click wiring in
  `wireCalendarDrag`).
- Manual-add endpoint: `api/desk-appointment.js` (+ `api/desk-appointment.test.js`).
- Schema: `migrations/20260728_calls.sql`, `_calls_notes.sql`, `_calls_resolved.sql`.

## Session change log
- 2026-07-30 — Documented the subsystem while adding three fixes after Josh's mis-routed
  drop-off: the outcome echo (§4), Close-vs-Mark-done (§5), and clearing the date on a
  chip switch (§3).
- 2026-07-30 — Added Desk **edit / re-route** (change type + date/time from the card;
  anon UPDATE) and **manual add** (`+ Add` / empty calendar slot; walk-in with no call,
  via `api/desk-appointment.js`). Documented the walk-in single-row representation (§1)
  and the endpoint (§8). Resolves the "no way to fix a mis-bucketed item / no manual add"
  gap.
