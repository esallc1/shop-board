# How the customer record is wired

> Doc: `/docs/wiring/customer-record.md`
> Last updated: 2026-07-30 — verified vs commit `bea25cf`
> Status: ✅ verified vs commit `bea25cf` — counts, recording union, and navigation re-checked against `shared/customer-record.js` and `#view-customer` in `advisor-board.html`.

## 0. In one line
A full customer view (`#view-customer`) with a top strip, vehicle chips, history, and
oldest-first recordings, reachable from an RO or a call with a back button.

## 1. Counts & "customer since"
- **CrisData-only and labeled as such** — old ALLDATA history isn't imported.
- `customers.created_at` is useless for this — use `min(repair_orders.created_at)`.
- `completed_jobs` has **no customer_id** — never use it for history or counts.

## 2. Which recordings show
- Confirmed (`calls.customer_id`) **plus** phone-matched unconfirmed (visibly tagged),
  `not_a_customer_at` excluded, and calls attached to a *different* customer excluded.

## 3. Navigation
- Opening a customer from an RO or a call navigates to the **full record** with a back
  button that returns where you came from. Not a hover preview.

## Known gaps & open questions (as of 2026-07-30)
- _(fill in as they arise)_

## Where it lives in the code
- `#view-customer` view (`advisor-board.html:852`) + Customers tab; `custBackBtn` back button
  (`advisor-board.html:864`), return target tracked by `custBackTarget` (`advisor-board.html:5606`)
- The tested reasoning — `buildRecordingCalls`, `customerCounts` (uses `min(repair_orders.created_at)`),
  `openRosOf`, `filterRecordingsByVehicle`, `canAssignRecording`, `roInvoiceTotal` — is in
  `shared/customer-record.js` (tested by `shared/customer-record.test.js`)

## Session change log
- 2026-07-29 — Customer record view shipped (`4ef6544`).
- 2026-07-30 — Verified vs `bea25cf`: CrisData-only counts, the confirmed+phone-matched recording union
  (with `not_a_customer_at` and other-customer exclusions), and full-record-with-back-button navigation
  all confirmed against code. Added `shared/customer-record.js` to "where it lives" (the tested logic lives there).
