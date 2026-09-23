# How the global search is wired
> Doc: `/docs/wiring/global-search.md`
> Last updated: 2026-09-23 — created with the top-bar search (Front Desk redesign; Cris's decisions 2026-09-23).
> Verified vs commit `fa7acfb`; shipped to prod in `99867a1` (2026-09-23) after Cris's OK.
> Status: 🟢 **LIVE on prod** (advisor board).
> Related: [[customer-record]] (§7 list, `cdOpenCustomerAtCall`, the honest list cache), [[call-window-desk]]
> (§6-log `cdDeskOpenLogAt`), [[intake-wizard]] (the New RO wizard), [[page-map]] (advisor tabs).

## 0. In one line
One search box in the advisor board's top bar, on every tab, that finds customers, vehicles, ROs and
old call notes — and the one "+ New RO" button, right next to it.

## 1. Where it is
- Mounted **once** into `.view-topbar` by `advisor-board.html` (`mountGlobalSearch({ db })`, a module
  before `</body>`). The bar reads **[☰] [Title] [🔍 search] [+ New RO] [🚩 Report a change]**;
  "Report a change" (`shared/report-change.js`) is appended by its own module and the search +
  New RO are inserted **before** it. Advisor board only.
- **"+ New RO"** (`#topNewRoBtn`) calls `window.cdOpenNewRo()` — the same wizard as before. The RO
  Board's own "+ New RO" (`#cdRoNewBtn`) and its listener were **removed** — one button, every tab.
  (The customer record's own "+ New RO", which starts an RO for *that* customer, is a different
  button and stays — [[customer-record]] §4d.)
- **The Customers tab's own search box was removed** (Cris) — its A–Z letters and full list stay
  ([[customer-record]] §7). The per-customer vehicle filter (`#custVehSearch`) stays.
- Results dropdown: `z-index 2950` — above the Desk pad (2800) and the Facebook tray (2900), below
  every modal (3000), the call-log drawer (3300), the call card (4000) and Team Chat.
- **Phone layout (≤ 768 px):** the top bar wraps and the search takes its own full-width row.

## 2. What it finds — and how
| Group | Source | Match |
|---|---|---|
| **Customers** | the board's own list cache — `window.cdEnsureCustList` (= `ensureCustAllList`, archive-filtered, invalidated on every customer write, realtime-refreshed, stale-while-revalidate) | name / business contains; or — **only when what was typed is a number** — ≥ 3 digits in either phone's last 10 (so the "683" in plate "XEE 683" doesn't pull in every phone with 683). Ranked: exact phone > a word starts with > contains > phone contains; ties A–Z |
| **Vehicles** | `vehicles` (+ owner embed) | `plate` or `vin` contains — "KXR 4471" also finds "KXR4471" (pieces joined by `*`) |
| **ROs** | `repair_orders` (+ customer, vehicle) | `ro_number` **equals** the digits, **or** `po` (old ALLDATA / 5xxx) **starts with** them. Shown as **"RO #6012 · PO 5473"** |
| **Call notes** | `calls.note`, `calls.outcome_note` | **every word** must appear, in either column (one `.or()` per word, AND-ed) |

- **Which groups run / lead** (`classifyQuery`): a VIN (17 chars) or a **plate-shaped** query (letters
  and digits, 4–8 characters, no run of 5+ letters — "XEE 683", "KXR4471"; not "2016 chevy") →
  Vehicles first; 2–5 digits →
  ROs first; a 7–10-digit number → Customers first (phone); letters → Customers first, and call
  notes are searched. Group order otherwise Customers · Vehicles · ROs · Call notes; up to 5 each.
- **Safe filters** (`safeWords`): anything that could break PostgREST's `or=(…)` syntax or act as a
  wildcard (`, . ( ) * " \ :` …) is turned into a space before it reaches a query.
- **Reads only**, with the board's own Supabase client and the viewer's session — no endpoint, no RLS
  change, no migration. A test fails if `shared/global-search.js` ever writes or calls an endpoint.
- **Speed:** 200 ms debounce; the four searches run together; a sequence number means an older
  answer can never paint over a newer one. Customers are filtered in the browser (~2,750 rows, already
  cached); vehicles / ROs / calls are small `limit(8)` queries.
- **A group that fails says so** ("Couldn't search Customers just now") — a customer list that didn't
  load **throws** instead of reporting "No matches" (the [[customer-record]] §4e lesson).

## 3. Where a result goes (`destination`)
- **Customer** → `window.cdOpenCustomerById` — their record.
- **Vehicle** → the **owner's** record; a merged-away owner opens the **survivor**
  (`CustomerArchive.mergedIntoId`).
- **RO** → switches to the RO Board and `window.cdOpenRo(id)`.
- **Call note, call attached to a customer** → `window.cdOpenCustomerAtCall(customerId, callId)` —
  the record, with the RO / vehicle the call is filed under opened and the call highlighted
  ([[customer-record]] §7).
- **Call note, no customer** → `window.cdDeskOpenLogAt(started_at, callId)` — the Desk's call log on
  that call's day, the call highlighted ([[call-window-desk]] §6-log). **Never** a guessed customer:
  if the number matches one customer, the log row's own "Attach to <name>" suggestion offers it and
  it still takes a tap. (A call with no `started_at` — a "+Add" row — opens the Desk.)

## 4. Keys
- **"/"** focuses the box and selects its text — **never** while typing in another field
  (`isTypingTarget`, the same rule as the Desk pad's N), never with Ctrl/⌘/Alt.
- **↑ / ↓** walk the results across groups (wrap-around); **Enter** opens the highlighted one; a click
  opens too; **Esc** closes the list (a second Esc clears the box).
- Clicking anywhere outside closes the list.
- `window.cdGlobalSearch.open(q)` opens the box with a query already typed (used for an ambiguous
  phone from the Desk / call log — [[customer-record]] §7).

## Known gaps & open questions (as of 2026-09-23)
- **RO number is an exact match** (`ro_number` is an integer — no partial); the old `po` is a
  prefix match. Typing "60" finds PO 60xx but not RO #6012 until the full number is typed.
- **Call notes use `ilike`, no index** — fine at 970 calls / 194 notes; a trigram or full-text index
  would be a migration if it grows to tens of thousands.
- `cnam` (CTM caller-ID, mostly a city) is deliberately **not** searched.
- Customers only from the cached list: a customer created in **another** browser appears once the
  realtime/refresh path marks the cache stale (seconds) — same as the Customers tab.

## Where it lives in the code
- `shared/global-search.js` — the DOM half: `mountGlobalSearch({ db })`, `window.cdGlobalSearch`.
- `shared/global-search-logic.js` — pure: `classifyQuery`, `groupOrder`, `searchCustomerList`,
  `vehicleOr`, `roOr`, `callOrs`, `safeWords`, `noteSnippet`, `roLabel`, `destination`,
  `flattenGroups`, `moveSelection`. Tested by `shared/global-search-logic.test.js`.
- `shared/global-search.css` — the box, the dropdown (z 2950), the phone-layout row.
- `advisor-board.html` — the stylesheet link, the mount module, `window.cdEnsureCustList`,
  `window.cdOpenCustomerAtCall` + `scrollCallIntoView` + `data-cust-call`, `window.cdDeskOpenLogAt`
  + `data-log-call`, the removed `#cdRoNewBtn` and `#custSearchInput`.
- `shared/cust-cache-guard.test.js` — also locks that the search reads the honest cache.

## Session change log
- **2026-09-23** — **shipped to prod** as `99867a1` together with the My Commission disable, after Cris's OK (he tried "leak" → call notes attached + not attached, and New RO in the top bar). Fast-forward `d11600a..99867a1`; www / board. / apex byte-identical (16 served files).
- **2026-09-23** — browser run on test.* (`fa7acfb`, ZZ Test Advisor, 1100×720 + 375 px): **name** "snooks" → Customers, Enter opened the record; **phone** "239 887 8557" → the customer; **plate** "XEE 683" → Vehicles only (after the fix) → opened the owner (ADMIER GONZALEZ); **VIN** "1FM5K7F88FGC13585" → the Ford Explorer; **RO#** "6026" → ROs first, Enter opened RO #6026; **old PO** "5473" → RO #5473 and prefix "547" → #5474 + #5473 (po match — in the sandbox every po equals its ro_number, so no "RO # · PO" pair exists to show); **call note with a customer** "vibrations shudder" → Fernando's record, the call highlighted in "needs filing"; **call note without** "sentra leaking" → call log on Wed Aug 12, row highlighted, no customer opened (no sandbox call exists whose number matches exactly one customer, so the "Attach to <name>" case wasn't shown live); **"/"** focused the box from the page and typed "/" inside a Desk-pad note; **↑/↓** walk + wrap, **Esc** closes; **+ New RO** from Desk and Customers → the same wizard at step 1, one button on the page; **Customers** tab: A–Z + list, no search box; **phone** 375 px: search on its own full-width row, no side-scroll. Only HTTP error: the pre-existing sandbox avatar sign URL.
- **2026-09-23** — found in the browser run: a plate ("XEE 683") listed 5 customers by the "683" in their phones above the vehicle. Phone matching now only for number-only queries; plate-shaped queries lead with Vehicles. Also: a business's contact name isn't repeated when it equals the business name.
- **2026-09-23** — created. Top-bar search (customers / vehicles / ROs incl. old PO / call notes) + the one "+ New RO"; Customers-tab search box removed (A–Z kept); results open the record (at a call), the RO, or the call log at a call. On staging.
