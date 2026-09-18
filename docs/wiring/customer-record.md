# How the customer record is wired

> Doc: `/docs/wiring/customer-record.md`
> **2026-09-18 — §4f added: the record's top-strip Edit button + duplicate-phone warning.**
> Verified vs commit `399e93c` (branch `feat/customer-edit-transmission`, UNMERGED — on staging
> only). §0, §4 (top strip), §4e's write-site table, §4f, Known gaps and Where-it-lives re-checked
> against the code this session, and §4f driven in a real browser on `test.*` (sandbox DB) — see
> the change log. Rest not re-verified.
> Previously: **2026-09-17 — §4e added: the cached customer list is refreshed on write, by realtime and on
> focus — as STALE-WHILE-REVALIDATE.** A customer created or renamed in the session used to stay
> invisible to the search until a full reload. The first attempt at this fix nulled the cache and
> shipped a worse bug (§4e "the second lie"), caught on staging. Verified vs `9fea3b1` + this
> branch, and by driving the real page in a browser against the sandbox (4 search/clear/search
> cycles clean; the same script reproduces "No matches." on the reverted build). §4e/§7
> re-checked, rest not re-verified.
> Previously: 2026-09-04 — §4d added: the profile card's two actions ("Open now" and the new
> "+ New RO"), why "+ New RO" opens the wizard BY ID rather than by phone, and why the archived
> gate is now load-bearing rather than belt-and-braces. Verified vs commit `035f1bd` + this
> slice's working tree, and by clicking the button on staging.
> Previously: 2026-08-22 — §0 + §4b: the RO photo buckets are now managed on this page, so
> "read-only except needs-filing" is no longer true. Verified vs `085e239` + the slice-3 working
> tree (UNMERGED — see [[ro-photos]]).
> Previously: 2026-08-18 — verified vs branch `feat/customer-record-veh-filter` (base `bd1f445`)
> (§4a added: the fleet filter on the vehicles accordion. §0/§5/§6 already carried the Phase 2
> auto-attach rewrite and the "File to RO…" second write. The Customers LIST — §7 — is
> unchanged from `420871c`.)
> Status: ✅ verified — the two-column record eyeballed in-browser against live Supabase
> (person + business, open-RO auto-expand, closed-RO lifetime $, per-RO call timeline,
> unfiled "needs filing" section, accordion toggle, sticky profile), and the §4a fleet filter
> exercised on Mint Motors' 31 vehicles (match, count, sort/expansion preservation, clear,
> 375px); pure logic re-checked against `shared/customer-record.js` +
> `shared/customer-record.test.js` (31 tests green).

## 0. In one line
A full customer view (`#view-customer`) reached from the **Customers LIST**. Opening a
customer shows a **two-column record**: a **sticky profile on the left** and the customer's
**vehicles as a collapsible accordion on the right** — each vehicle's ROs with a calls &
notes timeline beneath. Three parts of it write: the **Edit** button in the top strip, which
edits the customer's own contact fields (§4f); the **"needs filing"** section — filing a call
**recording to a vehicle** (§6) and filing a **call to an RO** (§6b); and, for office roles
only, the **RO photo buckets** under each RO (§4b). Everything else is read-only display.

## 1. Counts, "customer since" & lifetime $
- **CrisData-only and labeled as such** — old ALLDATA history isn't imported.
- `customers.created_at` is useless for "since" — use `min(repair_orders.created_at)`
  (`CustomerRecord.customerCounts().sinceIso`).
- **Lifetime $** = Σ of the invoice total of the customer's **CLOSED** ROs only
  (`custLifetimeClosed()` over `custTotals`, which is `CustomerRecord.totalsByRo` of the
  batched `ro_line_items` — `shared/ro-totals.js` underneath, so each RO's total includes its
  live card fee when `card_fee_on` is set; the RO read carries `card_fee_on`, passed as
  `cardFeeOnByRo`. [[card-fee]]). The tile is **omitted** when no closed RO has a total — never
  shown as `$0` or as a lifetime figure that pretends to include ALLDATA years.
- **Last activity** = best-available max of `customers.last_invoiced`, latest RO
  `created_at`, and the most recent call `started_at` (`custLastActivity()`).
- `completed_jobs` has **no customer_id** — never used for history or counts.

## 2. Which calls & recordings show
- The calls list is the union of two sources, computed by
  `CustomerRecord.buildRecordingCalls`: `calls.customer_id == this customer` (**CONFIRMED**)
  **plus** phone-matched unconfirmed (`caller_bare` last-10 == `phone_primary/secondary`,
  visibly tagged **unconfirmed**). `not_a_customer_at` excluded; a call attached to a
  *different* customer excluded.
- The **whole union** feeds the timelines (calls *and* notes), not only calls with audio. A
  ▶ recording button appears only when `RecordingPlayer.describeCallId` (fed by
  `/api/recording-links`) says one exists.

## 3. How it's reached / navigation
- From the **Customers LIST** (§7) via `showCustomerRecord`, or from an RO / call / Desk
  row via `window.openCustomerById(id, origin)` / `window.cdOpenCustomerByPhone(phone)`.
- A **back button** (`custBackBtn` → `custBack`) returns where you came from
  (`custBackTarget`: the list, a specific RO, or the prior view). Not a hover preview.

### 3a. The RO page remembers the customer too (`roBackTarget`)
The record ↔ RO trip used to be **one-directional**: RO → customer carried an origin, but
customer → RO did not, so `backToList()` always dumped the advisor on the RO list and he had to
re-find the customer by hand. Every time.

- **`openRo(roId, origin)` is the choke point.** It *sets* `roBackTarget` from `origin`, so every
  other entry — kanban card, RO list row, comeback-chain row, `window.cdOpenRo` — passes nothing
  and thereby **clears** it. Only the record's "Open RO #… →" supplies one. Clearing at the
  choke point is what makes a stale target unrepresentable; a leftover one would send him to a
  customer he never came from.
- **`custBack()`'s own call passes no origin**, so RO → customer → Back → RO → Back reaches the
  RO list instead of ping-ponging between two screens.
- Returning sets a one-shot `custPendingFocus`, consumed by `loadCustomerRecord`, which **derives
  the vehicle from the rows it just fetched** (not from anything carried) and opens that vehicle
  + that RO, then lands on it via `scrollRoRowIntoView` — measured at **72px from the top of the
  viewport**, not the top of the page. `custBack` (the record's own target) rides along inside
  `roBackTarget`, so the chain beyond the customer survives the round trip.
- The button **says where it goes**: `← Back to Mendez, Cristian`. `roBackLabel` caps the name at
  22 characters and `#cdRoBackBtn` caps the box at a flat **320px** — a plain px cap, NOT a `vw`
  unit, because `min(60vw, …)` resolves to 0 where the viewport reports 0 width and
  `overflow:hidden` then eats the whole label rather than trimming a long name.

### 3b. The LIST remembers its A–Z position
`custListScroll` is captured in `showCustomerRecord` **before** the panel is hidden (a hidden
element reports `scrollTop` 0, so reading it afterwards saves nothing) and restored in
`showCustomerList` **after** `renderCustSearch`, because `renderCustBrowse` zeroes the box on
every render.

The active A–Z letter is restored **explicitly** (`setActiveAzLetter(currentTopLetter())`), not
left to the scroll-spy: the spy is `requestAnimationFrame`-throttled and does not fire in a
hidden tab, so restoring the offset alone landed back at R with the bar still lit on A.

⚠ **None of the three scroll restores on this page use `requestAnimationFrame`.** rAF does not
fire in a hidden or backgrounded tab — measured as **one frame in four seconds** — and these run
precisely when a tab is being restored. They call synchronously (reading
`getBoundingClientRect()` forces layout, so the first attempt is already accurate) and re-assert
on a short `setTimeout` to catch the record growing after first paint as photo signed-URLs
resolve.

## 4. The record layout — two columns (`#custRecordPanel`)
Above the grid sits the **top strip** (`.cust-rec-strip`): `← Back` (`#custBackBtn`, §3) on the
left, **`Edit`** (`#custEditBtn`, §4f) on the right, wrapped in `.cd-new-anchor` with a **NEW**
corner tag (shown until `2026-09-26`, see [[new-badge]]). It is the only Edit control on the page.

`.cust-rec-layout` is a `320px 1fr` grid (single column ≤860px).

**LEFT — sticky profile (`#custProfile`, `renderCustProfile`).** Stays put while the right
side scrolls (`position:sticky`, static on narrow screens). Renders **only fields that
exist**:
- **Name.** A **person** shows phonebook **"Last, First"** (`custListLabel`, the same
  surname split as the LIST); a **business** shows `business_name`, with a `Contact: <name>`
  subline when a person name is also on file. A **Person / Business** badge sits above it.
- **Contact rows:** `phone_primary`, `phone_secondary` (+ `learned` tag when
  `isSecondaryLearned`), `email`, and an address block assembled from `address_line1/2` +
  `city, state postal_code` (`custAddrLines` — partial addresses render cleanly, e.g. state
  only). A row is skipped entirely when its field is blank.
- **Customer since** (§1) and **Last activity** (§1).
- **Stat tiles:** `# vehicles`, `# repair orders`, and **lifetime $** (only when derivable —
  §1).
- **Two action buttons** — see §4d.
- The **CrisData-only** caveat line.

**RIGHT — vehicles accordion (`#custVehicles`, `renderCustVehicles` → `vehRowHtml`).**
- One collapsible row per vehicle, **sorted by most-recent activity** (`vehActivity` = latest
  of the vehicle's RO `created_at` and its linked calls' `started_at`).
- **Row header:** `year make model`, a `VIN … · Plate …` subline, counts (`N ROs · M calls`
  — the call count is shown only when linkable), and a **status chip**: green
  **`Open · <stage>`** when the vehicle has an open/active RO (`status != 'closed'` and not
  `declined_at`), else **`Last <date>`** or **`No visits`**.
- **Accordion is single-open** (`custOpenVeh`; `toggleVeh` re-renders). It **auto-opens the
  most-recent vehicle that has an open/active RO** (`pickAutoOpenVeh`); if none is open, all
  start collapsed.
- **Expanded body (`vehBodyHtml`):** that vehicle's ROs **newest-first** — each an RO block
  with `RO #` (click → opens the RO), stage, date, invoice total, and the **`complaint`**
  service summary — and **beneath each RO its own calls & notes timeline** (the calls whose
  `ro_id` is this RO). A per-RO timeline **caps at 260px and scrolls inside the card**. Below
  the ROs, a **"Calls & notes · this vehicle"** timeline holds any vehicle-linked calls not
  tied to a specific RO (§5).

### 4d. The profile card's two actions (`renderCustProfile`, `wireCustRecordDelegation`)

Both are emitted into `#custProfile` and both are handled by the panel's **delegated** click
listener, so they survive every re-render.

- **`Open now — RO #… · <stage>`** (`.cust-openro`, `data-open-ro`) — **conditional**: rendered
  only when `CR().openRosOf(custRos)` returns one. Primary styling (accent border + fill on
  hover). Jumps to that RO, passing the `custBack` target so Back returns here (§3a).
- **`+ New RO`** (`.cust-newro`, `data-new-ro`) — starts a new RO for this customer without
  retyping the phone. Secondary styling (muted border/text, `display:block` so it sits on its
  own line under the primary action).

**`+ New RO` opens the wizard BY ID.** `startNewRoForCustomer` passes the whole `custCustomer`
**row** to `window.cdOpenNewRoForCustomer` (§ [[intake-wizard]]), which is
`openModal(); loadExistingCustomer(c);` — landing straight on that customer's vehicles.
`#cdRoModal` is a **top-level overlay**, not nested in any `.view`, which is why it opens cleanly
from `#view-customer`.

> ⚠ **The phone is never used, and there is deliberately no phone fallback.** This surface already
> holds the exact customer row, so there is nothing to look up. Re-deriving from the phone would
> throw that away and — on a shared number, e.g. "Allen Dave" and "Dave Allen" both on
> 239-265-4987 — show Step 1's **"multiple customers on this phone"** picker: a question we have
> the answer to. Pick the wrong twin and the RO attaches to the wrong record, splitting that
> customer's history further, which is the precise harm the dedupe work exists to prevent.
> A phone-first opener existed briefly (`cdOpenNewRoForPhone`) and was **deleted** when this
> replaced it — it had no callers left, and an uncalled live-looking global is what caused the
> bug below.

> ⚠ **NOT `cdOpenCustomerByPhone`.** That name is assigned twice in `advisor-board.html`: a wizard
> version first, then **repointed by this file's own customer IIFE** to open the customer RECORD
> ("Repoint the ONE phone entry point every call-log row / Desk row / chip uses"). The repoint runs
> later and always wins, so the wizard version was **dead code that looked live**, and calling it
> from the record would simply re-open the page you are already on. Found by clicking the button on
> staging, 2026-09-04 — not by reading, which is exactly how it hid.

**Ordering, for anyone changing `cdOpenNewRoForCustomer`:** `openModal()` runs `resetAll()`
synchronously before it returns, so it must come **first** and `loadExistingCustomer(c)` second —
the reverse would blank the state that was just set. `openModal`'s deferred
`cdPhoneInput.focus()` (+30ms) is harmless here: by then step 1 is `display:none`
(`.cd-step`/`.cd-step.active`, CSS ~:239) and a hidden input cannot take focus, so no keyboard
opens on the iPad.

Two behaviours worth knowing, both deliberate:

1. **Not rendered on an ARCHIVED record.** That row's work belongs to the keeper now, so a new RO
   has to be opened there; the merged banner's **"Open &lt;keeper&gt;"** is the route those users
   want. The gate is `!CustomerArchive.isArchived(c)`; the button is **not emitted at all**, never
   disabled-and-greyed. Gated on `isArchived` rather than `shouldShowMergedBanner` so an archived
   row with **no** keeper is covered too. See [[customer-dedupe]].
   > ⚠ **This gate is now the only thing enforcing that.** It used to be a belt on top of braces:
   > the button went through `lookupPhone`, which drops archived rows by itself. Since 2026-09-04
   > it opens by **id**, and an id opens any row, archived or not. Do not remove this gate on the
   > grounds that the lookup already handles it — there is no longer a lookup.
2. **A missing or junk phone is no longer a special case.** The 18 phoneless ALLDATA imports on
   staging have an `id` like anyone else, so they take the normal path and land on their vehicle
   picker. The empty-wizard fallback (`window.cdOpenNewRo()`, step 1) now fires **only when there
   is no customer row at all** — a state the record page should never be in. (Until 2026-09-04
   this button went through `lookupPhone`, which rejects anything under 7 digits, so a phoneless
   customer was dumped on step 1 to be typed in by hand. Going ID-first fixed that for free.)

### 4a. The fleet filter (`#custVehFilter`, `renderCustVehicles`)
A search box above the accordion, rendered **only when the customer has ≥
`CustomerRecord.VEHICLE_FILTER_MIN` (6) vehicles** (`shouldShowVehicleFilter`). Below that a
customer can see every vehicle at once and a search box is just another control in the way —
Jose has 2 and never sees it; Mint Motors has 31 and does.

**Why it exists:** the accordion sorts by most-recent activity, which is a sensible order for a
few cars and a **meaningless** one for a fleet where nothing has ever come in. Mint Motors' 31
vehicles all read `No visits · 0 ROs`, so "most recent" puts them in no discernible order and
finding one van meant eyeballing 31 near-identical rows.

- **Client-side only.** Filters the already-loaded `custVehicles`. **No new query, no db call,
  no write** — `custVehQuery` is the only state, and it is display-only and never persisted.
- **Matching** (`filterVehicles` / `vehicleSearchText` in `shared/customer-record.js`): one
  lowercase haystack per vehicle of `year make model plate vin`, **partial match anywhere** —
  `1267` finds plate `X1267 00`. Whitespace splits the query into tokens that must **all**
  match, so `2015 ford` and `ford 2015` both work. Field order puts `year make model` first so a
  natural phrase matches as one contiguous run.
- **Sort FIRST, filter SECOND.** `filterVehicles` only ever drops rows, so the activity sort
  survives untouched — and so does `custOpenVeh`: a vehicle the user expanded stays expanded,
  and if the filter hides it, **it is still open when the filter clears**. Filtering changes what
  is visible and nothing else.
- **Count** lands in the card note (`#custVehNote`): `3 of 31` while filtering, `31 vehicles`
  otherwise. An empty result says `No vehicles match "…"`.
- The box lives **outside `#custVehicles`** on purpose — the accordion re-renders on every
  keystroke, and re-rendering the input would kill focus and the caret mid-word.
- Switching customers resets the query (`loadCustomerRecord`), so a leftover filter can never
  silently hide vehicles on the next record.
- At ≤860px the input goes to `16px` so iOS doesn't zoom the page on focus.

### 4b0. The RO accordion (`roRowHtml`, `resolveOpenRo`, `toggleRo`)
Inside an expanded vehicle, **each RO is itself a collapsible row** — single-open, newest-first,
with the newest open by default. Deliberately the same visual language as the vehicle accordion
above it (§4): same chevron, same rotate-on-open, same head/body split, same accent border when
open. A second accordion pattern on one screen would be worse than none.

- **Collapsed header:** RO number, status, date, a one-line (ellipsised) complaint, invoice total
  and photo count — enough to identify the job without opening it.
- **State:** `custOpenRo` is three-state — `undefined` (open the newest), `null` (deliberately
  closed), or an id. Switching vehicles resets it to `undefined` so each vehicle opens on its own
  newest RO.
- **The head is a `<button>`**, so nothing clickable nests inside it: the "Open RO #… →"
  navigation lives in the body. That also keeps the one control that leaves this page away from
  the full-width tap target.
- A same-customer refetch preserves the open RO alongside the open vehicle and scroll.

### 4b. RO photo buckets — the page's other writes (office only)
Under each RO block, `roPhotosHtml(roId)` renders that RO's photos grouped by **buckets that
belong to that one repair order**. For `advisor` / `manager` (the GM) / `owner` it is also where
those buckets are **managed**: rename, add, remove, move a photo between them, and take a photo
without leaving the record. For anyone else it is exactly what it was — thumbnails and a
lightbox.

Three things to know here; the full wiring is [[ro-photos]] §5a/§5b:
- **The gate is `CHAT_IDENTITY.role`, which resolves ASYNCHRONOUSLY.** The first render genuinely
  has it null, so `applyIdentity` calls `window.cdCustomerRecordRerender()` when it lands.
- **Buckets are read in the same batched `.in()` pass** as the photos, and **both reads carry
  `.limit(2000)`** — they were unbounded.
- **Nothing re-renders while an inline editor is open**, and the caret is restored after the
  render that created it. Same lesson as the fleet filter input living outside `#custVehicles`
  (§4a): a render per keystroke kills the caret mid-word.
- **A photo or bucket write re-renders ONE RO in place** (`renderRoPhotos`), never the whole
  accordion — and a same-customer refetch now preserves `custOpenVeh`, the filter and the scroll
  position instead of resetting them. Full reasoning in [[ro-photos]] §5a0.

### 4c. The customer LIST caches an EMPTY load as "No customers."
`fetchAllCustomers` swallowed a page error with `break`, returning whatever had
accumulated — on a first-page failure, `[]`. `ensureCustAllList` then did
`if (custAllList) return custAllList`, and **`[]` is truthy**, so one dropped
request cached "no customers" for the life of the page. The board read
**"No customers."** on a database with ~2700 of them, and only a full reload
cleared it. Hit on a phone 2026-08-22 right after the camera failure.

Now: the failure is recorded on `window.cdCustFetchError` (the producer is in the
`callerCard` IIFE and the consumers are in another — a plain `let` would have been
two unrelated variables, which is how the first attempt at this fix was wrong),
`ensureCustAllList` **never caches a failed load**, and the empty state says
*"Couldn't load customers — &lt;reason&gt;"* with a **Try again** button instead of
claiming the shop has none.

**There is a SECOND way to get an empty array, and the first fix missed it.**
`ensureCustAllList` runs `window.cdFetchAllCustomers ? … : []` — and that function is assigned
in a LATER IIFE, so a boot-time view restore can call this before it exists. No error, no rows,
and the `[]` was cached for the life of the page: **"No customers." on a database with 2717 of
them.** Reproduced on 2026-08-23 while testing the A–Z restore. `custAllLoaded` now gates the
cache, so only a completed, error-free fetch is remembered — an absent fetcher is not evidence
of an empty shop, and neither is an error.

### 4e. …and it cached a STALE load as "no matches" (fixed 2026-09-17)
§4c made the cache refuse to remember a *failed* load. It still remembered a
**successful but out-of-date** one for the life of the page: `custAllLoaded` was cleared only by
the error-retry button, so a customer **created in the intake wizard, or renamed, minutes
earlier** was not in the list the search reads (`renderCustSearch` filters the cached
`custAllList` array, never the database). The search then reported **"No matches"** for somebody
who exists — and the natural next move is to create a second file for them, which is exactly the
duplicate-customer problem [[customer-dedupe]] exists to clean up. Hit on prod 2026-09-17.

The cache stays (re-reading ~2700 rows per keystroke is not a fix). Three nets mark it stale:

| Net | Covers | Where |
|---|---|---|
| `invalidateCustAllList()`, published as **`window.cdInvalidateCustList`** | every customer write **in this page** | called at all five write sites: the wizard's create (`createCustomer`) and "Edit details" (`saveCustomerDetails`), the record's Edit form (`saveCustEdit`, §4f), and the Desk attach phone-learn / un-learn (`setSecondaryIfNull`, the un-attach clear) |
| Realtime channel **`advisor-board-customers-live`** on `customers` | **another tab, another person** | same idiom as `-cdros-live` / `-desk-live`. ⚠ **Dead on staging:** the sandbox's `supabase_realtime` publication has **zero tables** (verified 2026-09-17), so nothing on `test.*` exercises realtime — the other two nets are what make cross-tab work there |
| `VIEW_REFRESH.customer.refetch` marks it stale | returning to the tab, incl. a dead socket | the backstop — marks stale, never fetches on its own |

### 4e-ii. The second lie: an emptied cache rendered as "no matches"
The first version of this fix set `custAllList = null` on every write **and on every focus**, and
both renderers read `custAllList || []` **synchronously**. So after any focus event the next
keystroke filtered an empty array and the panel said **"No matches."** — or **"No customers."**
with the box cleared — and stayed that way, because only `showCustomerList()` ever re-fetched and
the panel was already open. Same lie as §4c, reached from the opposite direction. It shipped to
staging as `b0ef5fc` and Cris caught it in minutes; it never reached prod.

The rule that replaced it: **nothing nulls a list that once loaded.**
- `invalidateCustAllList()` sets `custAllStale`; it clears the array only when there was never
  one to serve.
- `ensureCustAllList()` returns the stale rows **immediately** and kicks `refreshCustAllList()`
  behind them.
- `refreshCustAllList()` dedupes on `custRefreshInFlight`, re-renders through
  `rerenderCustListIfOpen()` only when its `custRenderSeq` is still current (a slow fetch can
  never clobber a newer render), and on failure **keeps the old list** — stale beats empty.
- Both renderers now distinguish **three** states, not two: load failed (retry button), **not
  loaded yet ("Loading customers…" + a fetch)**, and genuinely no customers.

**The lesson for the next cache here:** the static guard passed the whole time. This class of bug
only shows up by driving the page — search, clear, search again, with a focus event in between.

Why the invalidator is on `window`: the writers live in **other IIFEs** (the intake wizard, the
Desk caller card), the same scope split that §4c's first fix got wrong. `customers` is in the
`supabase_realtime` publication (`20260716_ro_foundation.sql`, REALTIME block), so the channel
really fires — that was checked, not assumed. Guarded by `shared/cust-cache-guard.test.js`,
which fails if any future `customers` write skips the invalidation.

**Timeline entry (`callEntryHtml`):** time (`started_at`), caller-ID (`cnam` / `caller_formatted`
/ formatted phone), a **disposition** chip from `calls.next_step`
(`NEXT_STEP_LABEL`), the advisor **note**, a ▶ recording when one exists, and an **unconfirmed**
tag for phone-matched calls. A confirmed entry has an accent left border; unconfirmed is amber.

### 4f. Editing the customer — the top-strip Edit button (`openCustEdit` / `saveCustEdit`)
One **Edit** button in the record's top strip opens **`#custEditModal`**. **Any office role** can
use it — the code has no role check for it (see *who can write* below).

**Why a modal and not an inline form:** `VIEW_REFRESH.customer.refetch` re-runs
`loadCustomerRecord` on every tab focus / app switch (§3b, [[ro-photos]] §5a0), which rewrites
`#custProfile`. A form inside the profile would be wiped mid-typing. `#custEditModal` is a
top-level overlay (next to `#cdLineModal`), outside every `.view`, so nothing re-renders it.
`custEditFor` pins the row the form was filled from, so a refetch that replaces `custCustomer`
underneath cannot change *which* customer the save targets.

**What it writes — `CustomerEdit.EDIT_FIELDS`, nothing else:** `name`, `business_name`,
`phone_primary`, `phone_secondary`, `email`, `address_line1`, `address_line2`, `city`, `state`,
`postal_code`. Deliberately **not**: `tax_exempt`, `delivery_preference`, `country`, and the
generated `phone_*_l10` columns (Postgres maintains those — `20260818_customers_phone_l10.sql`).
`buildCustomerPatch` trims every field and turns a blank into **NULL** (so a cleared field reads
"not on file" and §4's skip-blank-rows rule hides it). **Only `name` is required** (the column is
NOT NULL). A blank primary phone is allowed on purpose — the 18 phoneless ALLDATA imports must
be editable.

**The duplicate-phone warning.** Before writing, `saveCustEdit`:
1. `CustomerEdit.newPhoneKeys(before, patch)` — the last-10 keys of any phone in the form that
   this customer did **not** already carry in either field. An unchanged number, or a
   primary↔secondary swap, is not checked (it would nag on every save of a family that already
   shares a phone). Anything under 10 digits is never a key.
2. If there are keys: one server read, narrowed by `conflictOrFilter(keys)` (the same
   end-anchored ilike pattern as the wizard's `lookupPhone`, both phone columns, every key),
   `.is('archived_at', null)`, `.limit(50)`, with the usual missing-column fallback.
3. `CustomerEdit.findPhoneConflicts(rows, { selfId, keys })` is **the authority**: re-checks exact
   last-10 on every row, drops **self** (by id) and **archived** rows (`filterActive`), de-dupes.
4. Any hit → `#custEditDupe` names each other customer (`custListLabel`) with the matching
   number, a link to their record, and **Save anyway**. Nothing is written until Save anyway.
   The link closes the modal and opens that record (the edit is discarded — the warning says so).
   Typing in either phone box hides a stale warning. **It never merges and never blocks.**
5. If the check query itself errors, the warning says it *couldn't check* and still offers Save
   anyway — it does not silently skip the check.

**After the write** (`update(patch).eq('id').select('id')` — zero rows back is reported as a
failure, not success, so an RLS-dropped write can't look saved):
- `window.cdInvalidateCustList()` — the §4e cache learns the new name/phones.
- `window.cdDeskInvalidateCust()` — drops the Desk's private phone index (`custIdx`) and
  attach-picker snapshot (`attachAllCust`) so calls re-match against the new numbers.
- **Open RO:** if `currentRo.customer_id` is this customer, `currentRo.customers` is patched
  (name, phones, email) and `renderHeader()` repaints — the RO header and a print from that RO
  show the new values without a reopen. `loadRecentList()` refetches the kanban (its cards embed
  `customers(name, phone_primary)` and `allRos` carries no `customer_id` to patch in place).
- The record: `custCustomer` is patched and `renderCustProfile()` repaints at once, then
  `loadCustomerRecord(id)` re-reads (same-customer refresh keeps position — §3b) so phone-matched
  calls (§2) follow the new numbers.

**Who can write:** the board writes `customers` directly with the signed-in session. RLS today is
`for all to anon` (`20260716_ro_foundation.sql`) **plus** `auth write customers` `for all to
authenticated` (`20260801_office_auth_widen_step1_5.sql`) — both `using (true)`. When security
Phase 3 narrows Tier-A tables to `authenticated using (is_staff())`, this write keeps working for
signed-in office staff with no code change (and the `.select('id')` check will surface it loudly
if a session is missing).

## 5. Calls granularity — bucketing to the finest link the schema supports
`computeCallGroups()` puts every union call into exactly one bucket:
1. **`byRo[roId]`** — the call's **`ro_id`** points at one of THIS customer's ROs, so the call
   is shown **under that RO** (and thus that vehicle). The link is either **human-set** (the
   "checking on their car" RO picker, or an attach) or **machine-set** by auto-attach — the
   page renders both identically; which one it was is recorded on the row
   (`auto_ro_filed_at`), see [[call-auto-attach]] §3.
2. **`byVehNoRo[vehId]`** — no RO link, but the call's **recording is assigned to a vehicle**
   (`custRecVehId`, §6) → shown at the **vehicle** level, under "Calls & notes · this vehicle".
3. **`unfiled[]`** — links only to the customer → the **customer-level "needs filing"**
   section (`#custUnfiledCard`, `renderCustUnfiled`).

Calls carry **no vehicle_id of their own**; the only call→vehicle paths are (1) via `ro_id`→RO
and (2) via an assigned recording.

**Phase 2 (call auto-attach) is BUILT — see [[call-auto-attach]].** It is what fills `byRo`
without anybody typing: a call matching **exactly one** customer by phone is attached
automatically, and if that customer had **exactly one RO open at the time of the call**, its
`ro_id` is set too. It runs on arrival (CTM webhook) **and** re-runs whenever a human attaches
a call. Two hand-run backfills already applied it to the sandbox backlog — calls carrying an
`ro_id` went **4 → 46**, which is why the right column now has timelines under ROs at all.
It never guesses: 0 or 2+ matches leave the call in `unfiled`, and on the sandbox that is still
**~69% of the pile** (strangers whose number matches no customer). The "needs filing" section
is not going away — it is getting smaller.

## 6. Write 1 — filing a recording to a vehicle
Carried over unchanged from the old record view. It is the crew's way to attach a **recording
to a vehicle**, and it is **still the only write on this page** — auto-attach ([[call-auto-attach]])
turned out to be a different axis (call → customer → RO, written by the webhook and the Desk,
never by this page), so it does **not** replace this control as §5 previously predicted. It
lives **only in the unfiled "needs filing" section** — the natural home for a recording nobody
has filed yet:
- A **confirmed** recording that is currently unassigned gets a **`<select>`** of the
  customer's vehicles ("File to vehicle…"); an **unconfirmed** one gets a hint (attach the
  person link first — the server enforces this too).
- Change → `assignRecVehicle` POSTs **`/api/recording-assign`** (service-role; anon can't
  write recordings). On success it remembers the assignment for the session and
  **re-buckets** (`rerenderCustBody`), so the recording moves out of "needs filing" into its
  vehicle immediately.
- A recording's vehicle resolves in precedence order (`custRecVehId`): (1) this session's
  explicit assignment; (2) the **persisted** `recordings.vehicle_id` (via the links
  endpoint — survives reload, incl. on a call with no RO); (3) the call's linked RO's
  vehicle; (4) null.

## 6b. Write 2 — "File to RO…" (the manual re-file)
The Phase 2 companion: a `<select>` on each **needs-filing** entry that files the call to one
of **this customer's** ROs (`fileCallToRo`). It sits beside the recording→vehicle picker so
the two read as one filing block.

- **All of the customer's ROs, newest first, stage-labelled** — `#6009 · RO`, `#5451 · Closed`.
  **Closed ROs are included on purpose**: the real case is a customer ringing a week after
  pickup about the job that just closed, which auto-attach's "open at the time of the call"
  rule can never catch.
- **Confirmed calls only.** An unconfirmed phone match isn't established as this customer's
  call yet, so filing it to their RO would invent a link — the same gate the recording picker
  uses (`canAssignRecording`).
- On change it writes `ro_id`, **clears `auto_ro_filed_at` + `auto_attach_run_id`** (a human's
  choice leaves the robot's namespace, so no batch undo can revoke it — [[call-auto-attach]] §3),
  and stamps `noted_by_name`/`noted_at` when the call was never noted. Then `rerenderCustBody()`
  re-buckets and the entry **visibly jumps** out of "needs filing" up under its RO.
- Uses the existing anon/authenticated UPDATE policy on `calls` — no new RLS, no migration.

## 6c. The "auto" chip
A small neutral **`auto`** chip on any timeline entry whose `auto_attached_at` **or**
`auto_ro_filed_at` is set, next to the amber `unconfirmed` tag. Its tooltip says which half the
machine did (customer, RO, or both). Deliberately calmer than `unconfirmed` — it is
information, not a warning — but present so the crew can see a machine's guess and distrust it.

Everything outside the needs-filing section and the photo buckets (§4b) is **read-only
display**.

## 7. The Customers LIST panel (`#custListPanel`) — browse + search
The Customers tab opens a list panel with a search box, an **A–Z index bar** (`#custAzBar`),
and the list (`#custSearchList`). `ensureCustAllList()` loads **every** customer once via the
paginated `window.cdFetchAllCustomers` (past the 1000-row API cap — ~2700 rows). `renderCustSearch(q)`
then branches on whether the search box has text:
- **Empty box → browse mode (`renderCustBrowse`).** The full list, **sorted alphabetically** by
  the **sort key `custSortName`** (case-insensitive `localeCompare`, `sensitivity: 'base'`):
  a **business** sorts by its **business name**; a **person** sorts by **LAST NAME** (last token
  of `name` moved to the front, skipping a trailing **Jr/Sr/II/III/IV/V** suffix). **Row display
  = phonebook "Last, First"** for people (`custListLabel`), businesses **as-is**, single-token /
  junk-last-token names as-is (no trailing comma). Names whose sort key starts with a non-letter
  fall in a **"#" bucket that sorts last**. Each letter renders as its **own `.cust-group`
  wrapper** with a **sticky letter header**, which is what scopes each sticky header to its group.
- **A–Z bar (`renderCustAzBar`).** One button per letter A–Z + "#"; a letter with customers
  **jumps** the scroll box so that group's header sits at the top (`custJumpToLetter` — measures
  the non-sticky `.cust-group` wrapper), empty letters render **dimmed + non-clickable**. The
  current group's letter is **active** (scroll-spy `custAzScrollSpy`). Hidden while searching.
- **Non-empty box → search mode.** A flat filtered list (name/business substring, or last-10
  phone when ≥3 digits), capped at 60, no group headers.
- **Clicks delegated** on `#custSearchList` → `showCustomerRecord`; the A–Z bar has its own
  delegated listener. Additive, reads-only.
  ⚠ Multi-word surnames (e.g. "De La Cruz") key off the **last token** only.

## Known gaps & open questions (as of 2026-09-18)
- ⚠ **Back from a record opened off an RO lands on the Customers LIST, not the RO** (§3 says it
  returns to the RO). Pre-existing, not from §4f: `window.openCustomerById` sets
  `custBackTarget = origin` and then clicks the Customers sidebar item, whose `wireCustomerTab`
  listener (since `4ef6544a`, 2026-07-29) resets it to `{ kind: 'list' }`. Reproduced on staging
  2026-09-18 via the RO header's customer link with no edit involved. §3's claim is ⚠ Needs review.
- **Edit is offered on an archived (merged-away) record too.** Harmless — archived rows are
  excluded from every search/match, so a changed phone there matches nobody — but not gated.
- **Another tab's open RO won't pick up an edit** until it reopens the RO: the in-page patch in
  §4f covers only this tab, and realtime is dead on the sandbox (§4e table).
- **`customer_phones` is not consulted** by the duplicate check — it is still inert (no readers,
  see [[customer-dedupe]]); `phone_primary`/`phone_secondary` are the authority.
- **Two phone-edit paths still differ:** the intake wizard's "Edit details"
  (`saveCustomerDetails`) edits name + primary phone only, requires the phone, and runs **no**
  duplicate-phone check. The record's Edit (§4f) is the full one.
- **1,203 of 3,235 plated vehicle rows have a literal trailing `" 00"` in `plate`** —
  `"X1267 00"`, `"X837 00"`. It is **stored data, not display**: every one of the 1,203 has
  `vehicles.source = 'alldata'` and an `alldata_code`, all created on the import date
  (2026-07-28); zero CrisData-created rows have it, and `" 00"` is the *only* trailing token in
  the whole table. Untouched by design — the filter matches partially, so `x1267` finds it
  either way. Cleaning it is a separate data decision, not a display fix.
- **The `Contact:` subline is redundant for every business on file.** All **54** customers with
  a `business_name` also have `name` set to the *same* string, so §4's contact subline renders
  as `Contact: Mint Motors` under the title `Mint Motors`. There are **zero** businesses with a
  genuine contact person, so the line currently carries no information for anyone. Not changed —
  suppressing it when `name == business_name` is a one-line fix whenever you want it.
- Most inbound calls have no `ro_id`, so they land in **`unfiled`** ("needs filing") rather
  than under a vehicle/RO. That's honest to the schema today; **Phase 2 auto-attach** is what
  fills in `byRo`.
- ▶ recording playback and the file-to-vehicle `<select>` need the Vercel `/api/*` functions,
  so they don't render under a bare static preview (they light up on staging/prod).
- **Duplicate customers/vehicles** from the ALLDATA import can split a person's history across
  two rows (e.g. same VIN on two vehicle rows). The page renders each gracefully; the dedupe
  is a separate effort (`customer-dedupe.md`).

## Where it lives in the code
- **Record markup:** `#custRecordPanel` in `advisor-board.html` — `.cust-rec-layout`,
  `#custProfile` (left), `#custVehicles` (accordion), `#custUnfiledCard`/`#custUnfiledBody`
  (needs filing), the single reused `#custRecAudio`. `.cust-*` CSS in the same file.
- **Record JS (advisor-board customer IIFE):** `loadCustomerRecord` (fetches customer incl.
  contact fields, vehicles, ROs incl. `complaint`, `ro_line_items` totals, the two call
  sources); `renderCustProfile`; `renderCustVehicles`/`vehRowHtml`/`vehBodyHtml`;
  `timelineHtml`/`callEntryHtml`; `renderCustUnfiled`; `computeCallGroups`, `vehActivity`,
  `vehCallCount`, `custVehiclesSorted`, `pickAutoOpenVeh`; `custRecVehId`, `assignRecVehicle`,
  `rerenderCustBody`, `toggleVeh`; format helpers `custFmtDate`/`custFmtWhen`/`custAddrLines`/
  `custLastActivity`/`custLifetimeClosed`. Delegated events: `wireCustRecordDelegation`
  (play / open-RO / accordion toggle / file-to-vehicle / **new-RO**). Recording playback reuses
  `window.RecordingPlayer` + `/api/recording-links`; filing uses `/api/recording-assign`.
- **List JS (§7):** `custSurnameSplit`/`custSortName`/`custListLabel`/`custDisplayName`,
  `custBucket`/`custAlphaCmp`, `renderCustBrowse`/`renderCustAzBar`/`custJumpToLetter`, the
  active-letter helpers, `renderCustSearch`, `wireCustListDelegation`; full-list load via
  `window.cdFetchAllCustomers`.
- **Fleet filter (§4a):** markup `#custVehFilter` / `#custVehSearch` / `#custVehClear` +
  `.cust-veh-filter*` CSS in `advisor-board.html`; state `custVehQuery`; applied in
  `renderCustVehicles`, reset in `loadCustomerRecord`, listeners in
  `wireCustRecordDelegation`. Rules in `shared/customer-record.js`.
- **Edit (§4f):** `#custEditBtn` in `.cust-rec-strip`; `#custEditModal` (+ `#custEditDupe`,
  `.cust-edit-dupe` CSS) in `advisor-board.html`; JS in the customer section of the RO IIFE:
  `CUST_EDIT_INPUTS`, `openCustEdit`, `closeCustEdit`, `showCustEditDupe`/`hideCustEditDupe`,
  `saveCustEdit`. Pure logic `shared/customer-edit.js` (`EDIT_FIELDS`, `buildCustomerPatch`,
  `newPhoneKeys`, `conflictOrFilter`, `findPhoneConflicts` — built on `shared/phone-lookup.js`
  + `shared/customer-archive.js`), tested by `shared/customer-edit.test.js` (14 cases). Desk hook
  `window.cdDeskInvalidateCust` (desk IIFE).
- **Profile actions (§4d):** `.cust-openro` / `.cust-newro` CSS in `advisor-board.html`;
  `renderCustProfile`'s `canNewRo` gate (`window.CustomerArchive.isArchived`);
  `startNewRoForCustomer` + the `[data-new-ro]` branch in `wireCustRecordDelegation`;
  entry points `window.cdOpenNewRoForCustomer` / `window.cdOpenNewRo` (see [[intake-wizard]]).
  `window.cdOpenCustomerByPhone` (`advisor-board.html`, customer IIFE) is a DIFFERENT thing —
  it opens the customer RECORD and is what the Desk / call-log rows / phone chips use.
- **Pure logic:** `shared/customer-record.js` (`buildRecordingCalls`, `customerCounts`,
  `openRosOf`, `sortNewestFirst`, `totalsByRo`/`roInvoiceTotal`, `canAssignRecording`,
  `isSecondaryLearned`, and the §4a filter: `VEHICLE_FILTER_MIN`, `shouldShowVehicleFilter`,
  `vehicleSearchText`, `filterVehicles`), tested by `shared/customer-record.test.js`. `filterByVehicle` /
  `filterRecordingsByVehicle` remain exported + tested but are **no longer called by the
  board** (the accordion groups calls itself via `computeCallGroups`).

## Session change log
- 2026-09-18 — Card fee became a live per-RO switch; RO totals here now come from `shared/ro-totals.js` (see [[card-fee]]). Branch `feat/card-fee-live`, unmerged.
- 2026-09-18 (later) — **§4f re-verified SIGNED IN** as ZZ Test Advisor (advisor role,
  `authenticated` JWT, sandbox) on `test.*`: every Supabase/`/api` request carried the user's
  bearer token (logged per request); email + second phone + address saved and survived a reload;
  blank primary phone → `NULL`; duplicate phone → warning, link opened the right record, nothing
  written until Save anyway, rows stayed separate (no merge-log rows); no 401/403/42501 (only
  storage `NoSuchKey` 400s for files missing from the sandbox). Also added the NEW pill beside
  Edit ([[new-badge]]).
- 2026-09-18 — **§4f: Edit button + duplicate-phone warning.** One Edit in the record's top
  strip opens a modal for name, business, both phones, email and address (only name required).
  A new/changed phone that another **live** customer carries (last-10, either field, self and
  archived excluded) is named with a link to their record and a **Save anyway** — never merged.
  Save invalidates the §4e cache and the Desk's phone index, patches an open RO's header, and
  refetches the kanban. New `shared/customer-edit.js` + 14 tests. Branch
  `feat/customer-edit-transmission` (`66fed18` + `399e93c`), unmerged. **Driven in a browser on
  `test.*` (sandbox), board open without a sign-in (anon):** email + second phone + full address
  saved and survived a full reload (DB row checked); primary phone blanked → saved as `NULL`;
  primary set to Dummy Test's number → warning named "Test, Dummy", **nothing written** until
  Save anyway (DB checked), the link opened Dummy Test's record, Save anyway wrote it and both rows
  stayed separate and un-archived; the in-session customer search found both on that number with
  no reload; renaming ALEXANDRA from her RO repainted RO #6034's header and kanban card without a
  reopen. Test rows restored afterwards. Found the pre-existing Back bug above.
- 2026-09-17 — **§4e + §4e-ii: the customer-list cache is now stale-while-revalidate.** Marked stale by every customer write, by realtime on `customers`, and on tab focus; the old rows keep serving until fresh ones land, and both renderers now say "Loading customers…" instead of "No matches." for a cache that hasn't loaded. The nulling version (`b0ef5fc`, staging only) produced exactly that lie and was replaced before prod. Also recorded: the **sandbox has no realtime at all** (empty publication), so `test.*` cannot exercise that net. Guard test: `shared/cust-cache-guard.test.js` (9 cases), plus an in-browser search/clear/search proof.
- 2026-09-04 — **Added "+ New RO" to the profile card** (§4d). Starts a new RO for the customer
  on screen by calling the wizard's existing `cdOpenCustomerByPhone`, so the phone is never
  retyped — no new matching logic. **Not rendered on an archived record**, because `lookupPhone`
  excludes merged-away customers and would otherwise walk the advisor into create-new-customer
  and mint a duplicate of the row that was just merged away. A phone under 7 digits falls back
  to the plain wizard rather than into `lookupPhone`'s own error state. No schema change, no new
  query, no new module.
  **Also found + fixed:** `cdOpenCustomerByPhone` is assigned twice, and the second assignment
  (the customer IIFE's repoint to the record page) had silently made the first — the wizard
  opener — dead code. The wizard opener is now `cdOpenNewRoForPhone` so it cannot be shadowed
  again; every existing `cdOpenCustomerByPhone` caller wants the record and is unchanged.
- 2026-09-04 — **"+ New RO" switched from phone-derived to ID-first** (§4d), after staging turned
  up "Allen Dave" / "Dave Allen" sharing 239-265-4987: the phone path showed the "multiple
  customers on this phone" picker on a page that already held the exact row, and picking the wrong
  twin would have attached the RO to the wrong customer. It now passes the row to
  `cdOpenNewRoForCustomer` (`openModal` + `loadExistingCustomer`) with **no phone fallback**.
  `cdOpenNewRoForPhone` was deleted — no callers left. Two knock-ons: the 18 phoneless ALLDATA
  imports now reach their vehicle picker instead of an empty step 1, and the archived gate stopped
  being redundant with `lookupPhone`'s own archive filter and became the only thing enforcing it.
- 2026-08-18 — **Added the fleet filter to the vehicles accordion** (§4a). A search box over
  plate / VIN / year / make / model, shown only at ≥6 vehicles, filtering the already-loaded
  list client-side with no new query and no write. Sort and expansion state are both preserved
  by construction (filter only drops rows). New pure logic + 8 tests in
  `shared/customer-record.js`: `VEHICLE_FILTER_MIN`, `shouldShowVehicleFilter`,
  `vehicleSearchText`, `filterVehicles`. Verified in-browser on Mint Motors (31 vehicles):
  `promaster` → 3 of 31, `1267` → the one van with plate `X1267 00`, `ford transit` → 13 of 31,
  mixed case fine, no-match message fine; Jose (2 vehicles) never sees the box; an expanded row
  filtered away came back **still expanded**; order after clearing was byte-identical to before;
  focus survived typing; no horizontal overflow at 375px.
- 2026-08-23 — **§3a/§3b added: Back now returns to the customer, and the A–Z list keeps its
  place.** customer → RO → Back landed on the RO list, so Cris re-found the customer by hand
  every time; it now returns to the record with that RO open and scrolled to 72px from the top.
  The list's A–Z offset and active letter are restored too. Three findings on the way: all
  three scroll restores on this page were written with `requestAnimationFrame`, which does not
  fire in a hidden tab (measured: one frame in four seconds) — replaced with a synchronous call
  plus a `setTimeout` re-assert; the active A–Z letter needed setting explicitly rather than
  waiting on the rAF-throttled scroll-spy; and §4c's empty-list bug had a second cause the first
  fix missed.
- 2026-08-22 (round 3) — **§4b0 added: each RO is now a collapsible row.** Cris could not tell
  where one job ended and the next began. Mirrors the vehicle accordion exactly; newest RO open
  by default; the open RO is preserved across a same-customer refetch alongside the open vehicle
  and scroll. See [[ro-photos]] §5a0/§5a1.
- 2026-08-22 (round 2) — **A same-customer reload no longer moves the reader.**
  `loadCustomerRecord` keeps the open vehicle, the fleet filter and the scroll position when it
  is refreshing the customer already on screen (it fires on every `visibilitychange`/`focus`,
  i.e. every phone app-switch), and skips the blanking placeholder. Opening a different customer
  still resets everything. See [[ro-photos]] §5a0.
- 2026-08-22 (later) — **§4c added: a failed customer load rendered as "No
  customers."** `[]` is truthy, so `ensureCustAllList` cached an empty result
  permanently. Pre-existing, not caused by the photo slice, but Cris hit it in
  the same session. The empty state now distinguishes "none" from "couldn't
  load" and offers a retry.
- 2026-08-22 — **§4b added; §0 and §5's "read-only" claim corrected.** The RO photo grids under
  each RO gained office-only bucket management (rename / add / remove), per-photo move, and an
  on-RO camera, so this page now carries writes outside the needs-filing section. The bucket read
  joined the existing batched `.in()` pass and both it and the photo read gained `.limit(2000)`.
  Built, UNMERGED, no migration applied anywhere — [[ro-photos]] is the wiring.
- 2026-08-18 — **Added the manual re-file control + the auto chip** (§0, §6b, §6c). The
  needs-filing section gained a "File to RO…" `<select>` (all of the customer's ROs newest-first,
  **closed included**, confirmed calls only) that re-buckets the entry on change; and timeline
  entries now show an `auto` chip where the machine made the link. The page is no longer a
  one-write page — §0 and §6 said "one write" and now say two. Verified in-browser against the
  sandbox: 25 selects rendered on a customer with 25 unfiled confirmed calls, the closed RO
  #6001 listed, the patch carried `auto_ro_filed_at: null` + `auto_attach_run_id: null`, and the
  entry left needs-filing (25 → 24).
- 2026-08-18 — **§5/§6 corrected: Phase 2 auto-attach shipped.** §5 no longer calls the
  `byRo` link "human-set" or auto-attach "deferred" — `byRo` is now filled by the machine as
  well as by hand, and the new [[call-auto-attach]] doc owns the rules. §6 drops the stale
  prediction that auto-attach would replace the recording→vehicle control: it is a different
  axis (call→customer→RO) written by the webhook and the Desk, never by this page, so that
  control stands unchanged and remains this page's only write. No code changed in the record
  view this session.
- 2026-08-12 — **Rebuilt the record detail into the two-column layout** (§0, §4–§6): a
  sticky left profile ("Last, First" / business, Person·Business badge, contact fields shown
  only when present, since/last-activity, vehicles/ROs/**lifetime $** tiles) and a right-side
  **vehicle accordion** (sorted by activity, status chip, auto-open the open-RO vehicle) whose
  expanded rows show each RO with a **calls & notes timeline** beneath. Added **call
  granularity bucketing** (`computeCallGroups` → byRo / byVehNoRo / unfiled, §5) using the
  real `calls.ro_id` link, and moved the **recording→vehicle assign control** (the one write,
  §6) into the unfiled "needs filing" section — kept working, not dropped. Vehicle filter-chips
  and the flat History/Recordings columns are gone. Read-only otherwise; no migration. Verified
  in-browser against live Supabase; module tests green. The LIST (§7) is unchanged.
- 2026-08-11 — **Fixed the A–Z letter jump (upward jumps were dead)** and **Customers LIST
  polish: "Last, First" rows + active-letter feedback** (§7). List rows display phonebook
  "Last, First" for people; the A–Z bar shows an active letter via a scroll-spy; jump measures
  the non-sticky `.cust-group` wrapper. Verified in-browser at 2716 customers.
- 2026-08-11 — **Added an A–Z quick lookup to the Customers LIST** (§7): full alphabetical
  browse (people by last name), a clickable A–Z bar, sticky per-letter headers; search
  behavior unchanged.
- 2026-07-30 — Verified vs `bea25cf`: CrisData-only counts, the confirmed+phone-matched
  recording union, and full-record-with-back-button navigation confirmed against code. Added
  `shared/customer-record.js` to "where it lives".
- 2026-07-29 — Customer record view shipped (`4ef6544`).
