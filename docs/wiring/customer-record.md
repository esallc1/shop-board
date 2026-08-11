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
- **Empty box → browse mode (`renderCustBrowse`).** The full list, **sorted alphabetically** by
  the **sort key `custSortName`** (case-insensitive `localeCompare`, `sensitivity: 'base'`, so
  punctuation sorts before letters — "A/C Quality Electric" precedes "ACTION…"):
  - a **business** (has `business_name`) sorts by its **business name**;
  - a **person** sorts by **LAST NAME** — the last token of `name` moved to the front
    ("Aaron Coleman" → `coleman aaron`), skipping a trailing **Jr/Sr/II/III/IV/V** suffix
    ("Bob Smith Jr" → `smith bob jr`, bucket **S**). A single-token name sorts as-is.
  **Row display = phonebook "Last, First"** for people (`custListLabel`): "Wyatt Tabb" shows as
  **"Tabb, Wyatt"**, "Bob Smith Jr" as **"Smith, Bob Jr"** — the SAME surname split as the sort
  (`custSurnameSplit`, the one place the surname is computed), so the label matches where the row
  sorts/jumps. Businesses show **as-is** (no comma flip); a single-token name, or a junk last token
  that isn't a real letter (`\p{L}` guard, e.g. "SANDRA ."), shows as-is with **no trailing comma**.
  The **record header** still shows the person's normal **First Last** (`custDisplayName`) — the
  flip is LIST-only. Names whose sort key starts with a non-letter fall in a **"#" bucket that sorts
  last** (`custBucket` derives from `custSortName`, so a group's header letter always matches where
  its rows actually sort). Rows are grouped by first letter with a **sticky letter header**
  (`.cust-group-head`, styled as a bold accent "T"-style divider); the list gets a `cust-browse`
  class making it its own scroll box.
  ⚠ Multi-word surnames (e.g. "De La Cruz") key off the **last token** only, so they bucket/label
  under that token's letter ("Cruz, Maria De La") — a known limitation of the naive last-name split.
- **A–Z bar (`renderCustAzBar`).** One button per letter A–Z + "#". A letter with customers is
  clickable and **jumps** the scroll box so that group's header sits at the top
  (`custJumpToLetter` — scrolls by the header's live `getBoundingClientRect` delta, robust vs.
  the sticky-header `offsetTop` trap); a letter with **no** customers renders **dimmed +
  non-clickable** (`.disabled`). **Active-letter feedback:** the current group's letter is
  filled/accent (`.active`) — set on click and kept in step with scrolling by a rAF-throttled
  scroll-spy (`custAzScrollSpy` → `currentTopLetter` → `setActiveAzLetter`). The bar is **hidden
  while a search is active** (grouping doesn't apply to filtered results).
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
  CSS; the JS `custSurnameSplit` (shared surname split) → `custSortName`/`custListLabel`
  ("Last, First"), `custDisplayName` (record header, First Last), `custBucket`/`custAlphaCmp`,
  `renderCustBrowse`, `renderCustAzBar`, `custJumpToLetter`, the active-letter helpers
  (`setActiveAzLetter`/`currentTopLetter`/`custAzScrollSpy`), and `renderCustSearch` (browse/search
  branch) — all in the `advisor-board.html` customer IIFE; the delegated click + scroll wiring in
  `wireCustListDelegation`. Full-list load via `window.cdFetchAllCustomers` (paginated past the
  1000-row cap).
- The tested reasoning — `buildRecordingCalls`, `customerCounts` (uses `min(repair_orders.created_at)`),
  `openRosOf`, `filterRecordingsByVehicle`, `canAssignRecording`, `roInvoiceTotal` — is in
  `shared/customer-record.js` (tested by `shared/customer-record.test.js`)

## Session change log
- 2026-08-11 — **Customers LIST polish: "Last, First" rows + active-letter feedback** (§4).
  List rows now display phonebook **"Last, First"** for people (`custListLabel`, "Wyatt Tabb" →
  "Tabb, Wyatt") using the SAME surname split as the sort (extracted to `custSurnameSplit`), so the
  A–Z jump visibly lands where expected; businesses + single-token/junk names show as-is (no flip),
  and the **record header keeps First Last**. The A–Z bar now shows an **active letter** (filled
  accent) set on click and updated by a scroll-spy; the sticky group divider is bigger/bolder
  (accent "T"-style heading). Sort order, jump, and search behavior otherwise unchanged. Additive,
  reads-only. Name logic verified by a node harness (label ↔ sort/bucket agree; Jr/Sr + accented
  surnames + "SANDRA ." guard); UI eyeballed on `test.leetransmissionshop.com`.
- 2026-08-11 — **Added an A–Z quick lookup to the Customers LIST** (§4). The default (no-search)
  view now renders **every** customer sorted alphabetically (businesses by business name, **people
  by LAST name** — `custSortName`, Jr/Sr/III suffixes skipped; "#" bucket last) instead of the old
  top-30-by-recency; added a clickable **A–Z index bar** (dimmed for empty letters) that jumps the
  list to a letter, and sticky per-letter group headers. The list became its own scroll box in
  browse mode; clicks are now delegated. The **search box behavior is unchanged** (bar hidden while
  searching). Additive, reads-only, no migration. Verified: browse render + A–Z jump + sticky +
  search + record-open + back in-browser at 2716 customers (first-name sort build); the last-name
  sort key verified by a deterministic harness (businesses by biz name, people by surname, suffix
  skip) and on the live prod deploy.
- 2026-07-29 — Customer record view shipped (`4ef6544`).
- 2026-07-30 — Verified vs `bea25cf`: CrisData-only counts, the confirmed+phone-matched recording union
  (with `not_a_customer_at` and other-customer exclusions), and full-record-with-back-button navigation
  all confirmed against code. Added `shared/customer-record.js` to "where it lives" (the tested logic lives there).
