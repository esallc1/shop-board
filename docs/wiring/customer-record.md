# How the customer record is wired

> Doc: `/docs/wiring/customer-record.md`
> Last updated: 2026-08-11 — verified vs branch `customers-az-index` (added the A–Z browse to
> the Customers LIST — §4; record detail unchanged from `bea25cf`)
> Status: ✅ verified — counts, recording union, and navigation re-checked against
> `shared/customer-record.js` and `#view-customer` in `advisor-board.html`; the new list A–Z
> browse verified in-browser (2716 customers, all 27 buckets, jump + sticky headers + search).

## 0. In one line
A full customer view (`#view-customer`) with a top strip, vehicle chips, history, and
oldest-first recordings, reachable from an RO or a call with a back button — fronted by a
**Customers LIST** panel that browses everyone A–Z (or filters by the search box).

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

## 4. The Customers LIST panel (`#custListPanel`) — browse + search
The Customers tab opens a list panel with a search box, an **A–Z index bar** (`#custAzBar`),
and the list (`#custSearchList`). `ensureCustAllList()` loads **every** customer once via the
paginated `window.cdFetchAllCustomers` (past the 1000-row API cap — ~2700 rows). `renderCustSearch(q)`
then branches on whether the search box has text:
- **Empty box → browse mode (`renderCustBrowse`).** The full list, **sorted alphabetically by the
  name AS DISPLAYED** — `custDisplayName` = `business_name || name` (a business sorts by its
  business name, a person by their displayed leading name), case-insensitive via `localeCompare`
  (`sensitivity: 'base'`, so punctuation sorts before letters — "A/C Quality Electric" precedes
  "ACTION…"). Names with a non-letter first char fall in a **"#" bucket that sorts last**
  (`custBucket` / `custAlphaCmp`). Rows are grouped by first letter with a **sticky letter header**
  (`.cust-group-head`) per group. The list gets a `cust-browse` class making it its own scroll box.
  ⚠ Sort is by the **displayed (leading) name** — for people that's the first name. Switching to
  last-name sort is a one-line change to `custDisplayName`/`custSortName`.
- **A–Z bar (`renderCustAzBar`).** One button per letter A–Z + "#". A letter with customers is
  clickable and **jumps** the scroll box so that group's header sits at the top
  (`custJumpToLetter` sets `scrollTop` from the header's `offsetTop`); a letter with **no**
  customers renders **dimmed + non-clickable** (`.disabled`). The bar is **hidden while a search
  is active** (grouping doesn't apply to filtered results).
- **Non-empty box → search mode (unchanged).** Exactly the prior behavior: a flat filtered list
  (name/business substring, or last-10 phone when ≥3 digits), capped at 60, no group headers.
- **Clicks are delegated** on `#custSearchList` (one listener survives the ~2700-row re-render) →
  `showCustomerRecord`; the A–Z bar has its own delegated listener. Additive, reads-only.

## Known gaps & open questions (as of 2026-07-30)
- _(fill in as they arise)_

## Where it lives in the code
- `#view-customer` view (`advisor-board.html:852`) + Customers tab; `custBackBtn` back button
  (`advisor-board.html:864`), return target tracked by `custBackTarget` (`advisor-board.html:5606`)
- **List panel (§4):** `#custListPanel` markup — `#custSearchInput`, `#custAzBar`, `#custSearchList`
  (`advisor-board.html:~911`); `.cust-az-*` / `.cust-group-head` / `.cust-search-list.cust-browse`
  CSS; the JS `custDisplayName`/`custSortName`/`custBucket`/`custAlphaCmp`, `renderCustBrowse`,
  `renderCustAzBar`, `custJumpToLetter`, and `renderCustSearch` (browse/search branch) — all in
  the `advisor-board.html` customer IIFE; the delegated click wiring in `wireCustListDelegation`.
  Full-list load via `window.cdFetchAllCustomers` (paginated past the 1000-row cap).
- The tested reasoning — `buildRecordingCalls`, `customerCounts` (uses `min(repair_orders.created_at)`),
  `openRosOf`, `filterRecordingsByVehicle`, `canAssignRecording`, `roInvoiceTotal` — is in
  `shared/customer-record.js` (tested by `shared/customer-record.test.js`)

## Session change log
- 2026-08-11 — **Added an A–Z quick lookup to the Customers LIST** (§4). The default (no-search)
  view now renders **every** customer sorted alphabetically by displayed name (business by
  business name, person by displayed leading name; "#" bucket last) instead of the old top-30-by-
  recency; added a clickable **A–Z index bar** (dimmed for empty letters) that jumps the list to a
  letter, and sticky per-letter group headers. The list became its own scroll box in browse mode;
  clicks are now delegated. The **search box behavior is unchanged** (bar hidden while searching).
  Additive, reads-only, no migration. Verified in-browser (2716 customers, all 27 buckets, jump +
  sticky + search + record-open + back). Sort is by the **displayed** name — last-name sort is a
  one-line follow-up if wanted.
- 2026-07-29 — Customer record view shipped (`4ef6544`).
- 2026-07-30 — Verified vs `bea25cf`: CrisData-only counts, the confirmed+phone-matched recording union
  (with `not_a_customer_at` and other-customer exclusions), and full-record-with-back-button navigation
  all confirmed against code. Added `shared/customer-record.js` to "where it lives" (the tested logic lives there).
