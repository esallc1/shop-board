# How the customer record is wired

> Doc: `/docs/wiring/customer-record.md`
> Last updated: 2026-09-04 — §4d added: the profile card's two actions ("Open now" and the new
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
notes timeline beneath. Two parts of it write: the **"needs filing"** section — filing a call
**recording to a vehicle** (§6) and filing a **call to an RO** (§6b) — and, for office roles
only, the **RO photo buckets** under each RO (§4b). Everything else is read-only display.

## 1. Counts, "customer since" & lifetime $
- **CrisData-only and labeled as such** — old ALLDATA history isn't imported.
- `customers.created_at` is useless for "since" — use `min(repair_orders.created_at)`
  (`CustomerRecord.customerCounts().sinceIso`).
- **Lifetime $** = Σ of the invoice total of the customer's **CLOSED** ROs only
  (`custLifetimeClosed()` over `custTotals`, which is `CustomerRecord.totalsByRo` of the
  batched `ro_line_items`). The tile is **omitted** when no closed RO has a total — never
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

**Timeline entry (`callEntryHtml`):** time (`started_at`), caller-ID (`cnam` / `caller_formatted`
/ formatted phone), a **disposition** chip from `calls.next_step`
(`NEXT_STEP_LABEL`), the advisor **note**, a ▶ recording when one exists, and an **unconfirmed**
tag for phone-matched calls. A confirmed entry has an accent left border; unconfirmed is amber.

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

## Known gaps & open questions (as of 2026-08-18)
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
