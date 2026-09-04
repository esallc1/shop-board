# How the intake wizard (New RO flow) is wired

> Doc: `/docs/wiring/intake-wizard.md`
> Last updated: 2026-09-04 — "Where it lives in the code": the customer record's "+ New RO" is a
> new entry point, AND `cdOpenCustomerByPhone` is corrected — it opens the customer record, not
> this wizard; the wizard's phone-prefill opener is now `cdOpenNewRoForPhone`. Nothing about the
> flow itself changed. Verified vs commit `035f1bd` + this slice's working tree, and by clicking
> the button on staging.
> Previously: 2026-08-18 — verified vs branch `fix/intake-phone-lookup-cap` (base `7652c65`)
> (§4 added: `lookupPhone` FIXED — it was silently blind to 62.6% of customers. §5 added: the
> full unbounded-read audit. §3 = the vehicle dup guard; §1–§2 unchanged from `bea25cf`.)
> Status: ✅ verified — the guard driven end-to-end in the wizard against the sandbox with every
> write intercepted: prompt on a VIN re-type, "Use that vehicle" reaches the comeback step with
> zero writes, "different vehicle" inserts, and a make+model-only save stays silent.
> The phone-lookup fix verified in-browser against the sandbox: `8135909459` (JOSE RAMIREZ — the
> LAST row in the table) resolves; a dashed entry resolves; a customer stored as
> `(239) 785-8879` and outside the old 1,000 resolves to its duplicate pair; an unknown number
> still goes to create-customer. The query now pulls 2 rows where it used to pull 1,000.

## 0. In one line
The New RO wizard: phone → customer → vehicle → (comeback check, if the vehicle has history) → open the RO.

## 1. Steps (verified vs code)
- **Phone → customer → vehicle:** enter phone, pick/confirm customer, pick vehicle.
- **Comeback check (`cdStepComeback`, `advisor-board.html:3011`):** only appears when the
  chosen vehicle has a **prior RO on that exact `vehicle_id`**. `selectExistingVehicle` looks up
  the most-recent prior RO; if there is none it sets `parentRoId = null` and **skips straight to
  mint** (`advisor-board.html:3029-3033`). When a prior exists it asks "Back on the last job
  (#N), or something new?" — choosing Comeback sets `state.parentRoId` to that prior RO.
- **Mint step "Open the RO" (`cdStepMint`):** complaint/concern, odometer (optional), and an optional
  **"Use existing PO (legacy migration)"** box (`cdLegacyPoWrap`, `advisor-board.html:1720`) that
  reuses a v1-floor PO number as the RO# — `row.ro_number = legacyPo` (`advisor-board.html:3265`) —
  and marks the car checked-in automatically. This is legacy migration — **not** the comeback link.

## 3. The vehicle duplicate guard (`saveVehicle` → `shared/vehicle-match.js`)
`saveVehicle` used to **insert unconditionally**, so re-typing a truck on "+ Add a different
vehicle" minted a second row. The real case: `JOSE RAMIREZ` has `1993 Chevrolet c1500` (typed
07-27, carries the RO) and `Chevrolet C1500` (ALLDATA import 07-28, reads "No visits") — same
VIN, same plate. History isn't lost, but the record shows a phantom twin.

**Matching is CUSTOMER-SCOPED, never global.** 35 VINs in the table sit under 2+ customers and
~23 of those are duplicate *customers* rather than resold cars, so a global VIN rule would be
wrong dozens of times and would fight [[customer-dedupe]] instead of helping it. The rows come
from `state.customerVehicles`, which `renderCustomerVehicles` already loaded — **no extra query
to match**.

**Order: VIN → plate → make+model.** VIN is strongest (77% of rows have a usable one, and there
are no partial VINs — a VIN is either absent or full length); plate is broadest (99.5%);
make+model is the last resort for the 4 rows in the whole table that have neither.

⚠️ **Only a VIN or plate hit is a question** (`shouldPromptForMatch`). **A make+model-only match
saves silently.** This is the single most important decision in the guard: Mint Motors has
eleven `Ford Transit Connect` rows with ten distinct VINs — eleven real vans — so a make+model
prompt would fire on every fleet intake and train the crew to click straight through it, making
the prompt worthless exactly when it is right.

**The ALLDATA trailing `" 00"` is normalized out of plates on both sides** (1,203 rows carry it).
Order matters inside `normPlate`: the suffix comes off *before* punctuation is stripped, or
`"GR239 00"` becomes `"GR23900"` and never matches `"GR239"`. The stored data is **not** repaired
— we just refuse to let the import's artifact defeat a match.

**On a hit the insert is GATED** — nothing is written and the form shows the match inline
(`#cdVehMatch`):
> This looks like the **2019 Toyota Camry** already on **PEDRO MARTIN**
> VIN 4T1B11HK7KU224908 · Plate 44BAJI **(1 repair order)**
> Matched on same VIN. (2 rows on file match — this is the one with the history)

- **The RO count is the point.** A match with history is almost certainly the row they want, and
  it is the row whose absence caused the split. `pickBestMatch` offers the row with the most ROs,
  **not** the newest — for Jose and Pedro the newest is the empty import twin.
- The RO count is the **one** query the guard adds, for the 1–2 matched rows only, and only on
  the rare path where a match actually fires.
- **[Use that vehicle]** hands off to `selectExistingVehicle`, so the comeback check (§1) still
  runs exactly as it does when the advisor picks from the list.
- **[No, this is a different vehicle]** sets `vehMatchAcked` and re-presses Save, inserting as
  typed. The flag resets with the form, so it can never leak into the next vehicle.

**Gating the write is right here, unlike the phone-learning confirm** ([[call-window-desk]] §2c),
where the attach was the user's goal and had to complete either way. Here the insert *is* the
thing in question, so asking after writing would create the very duplicate being prevented.
There is deliberately **no default-to-no heuristic and no decline memo**: the evidence is the
match itself, shown in full, and every save is its own decision.

## 4. The phone lookup (`lookupPhone` → `shared/phone-lookup.js`) — FIXED 2026-08-18
**This was the real duplicate-customer leak, and it was much bigger than the vehicle one.**

`lookupPhone` did an **unbounded** `db.from('customers').select(...)` and filtered in JS.
PostgREST caps that at **1,000 rows**; the table has **2,717**. Measured on the sandbox:
**1,700 customers — 62.6% — were invisible to the wizard**, so the advisor was walked straight
into *create a new customer* for most of the shop's book. On every intake, every day.
`JOSE RAMIREZ` (813-590-9459) is literally the **last row** in the table and did not resolve.

⚠️ The cruel part: the caller card's `matchCustomers` has always used `fetchAllCustomers()`,
which **pages properly** with `.range()`. The correct helper existed the whole time; the wizard
just never used it.

**The fix: narrow on the SERVER, confirm in the client.** Paging 2,717 rows into the browser to
search them is the wrong shape and gets worse as the shop grows, so the query filters server-side.

Phone numbers are stored **as typed** — three shapes live in the table (`8135909459` ×2750,
`(786) 531-5419` ×32, `786-531-5419` ×1) — so no equality filter finds them all.
`PhoneLookup.ilikePatternFor` builds an **end-anchored** wildcard pattern from the last 10 digits
(`*813*590*9459`); the area code, exchange and line number are contiguous runs in every standard
format, whatever punctuation sits between them. **Verified against all 2,783 stored values: zero
misses.** Both phone columns are covered in one request via `or=`.

🚩 **It deliberately does NOT use `phone_primary_l10` / `phone_secondary_l10`.** Those generated
columns come from `migrations/20260818_customers_phone_l10.sql`, which has been run on the
**SANDBOX ONLY**. Filtering on them would make this lookup return **nothing for every customer on
prod**. The ilike pattern needs no migration and works on both projects today. A test asserts the
filter string never contains `_l10`.

The pattern only **narrows**. `PhoneLookup.confirmPhoneMatches` re-checks **exact last-10** on
every returned row and de-dupes by id, so an over-broad pattern can never produce a wrong match.
The query now returns 2 rows where it used to return 1,000.

⚠️ A leading-wildcard `ilike` cannot use the `idx_customers_phone_primary` index, so this is a
sequential scan server-side — trivial at 2,717 rows, and still far cheaper than shipping the
table to the browser. If it ever matters, the fix is to run the `_l10` migration on prod and
switch to an indexed equality filter.

## 5. Audit — every unbounded read in the codebase (2026-08-18)
159 `select()` call sites were checked against their table's live row count. **No other read
that drives a MATCH or a SEARCH is unbounded** — the remaining full-table reads are display or
rollup queries on small tables. Ranked by what breaks when the table passes 1,000:

| File:line | Table | Rows now | Can exceed 1,000? | What silently breaks |
|---|---|---:|---|---|
| ~~`advisor-board.html:3380` `lookupPhone`~~ | `customers` | 2,717 | **ALREADY OVER** | **FIXED (§4)** — was inventing duplicate customers |
| `bookkeeping-board.html:3098` | `completed_jobs` | 49 | yes, slowly | Financial Pulse job-category rollup — **wrong TOTALS**, silently understated. Worst of the survivors: a number, not a list |
| `gm-board.html:1788` | `completed_jobs` | 49 | yes, slowly | GM comeback/warranty stats under-count |
| `advisor-board.html:4075/4080` | `repair_orders` | 54 | yes | RO Board stops showing older ROs (ordered newest-first, so the tail drops first) |
| `owner-board.html:785` | `marketing_content` | 11 | eventually | Marketing tab loses the oldest items |
| `shared/report-change.js:1067` | `change_requests` | 23 | eventually | Requests list truncates |
| `bookkeeping-board.html:1461/1468/1516/1517` | `expense_categories`, `invoice_types` | 7 / 4 | no | — |
| `shared/board-settings.js:225/264` | `payment_methods`, `package_units` | 5 / 50 | no | — |
| `shared/build-sheet.js:289/304/614` | `unit_parts`, `parts_library` | 4 / 1 | unlikely | Build-sheet parts library truncates |
| `gm-board.html:2218/4270`, `shared/commission-engine.js:295` | `employees` | 10 | no | — |
| `shopboard_*`, `tech_whiteboard` (many sites) | floor tables | 2–12 | no | — |
| `gm-board.html:1630`, `bookkeeping:3088` | `core_charges` | 1 | unlikely | — |
| `gm-board.html:4047` | `transmissions` | 7 | no | — |
| `advisor-board.html:2449`, `bookkeeping:2684` | `parts_orders` | 1 | eventually | Parts list truncates |

**Already safe, worth knowing why:**
- `vehicles` (3,251 — over the cap) is **never** read unbounded; every site is
  `.eq('customer_id', …)`.
- `customers` A–Z browse uses the **paged** `window.cdFetchAllCustomers`; the caller card's
  `matchCustomers` and the Desk attach picker use the same helper.
- `calls` reads are all narrowed by `customer_id`, `caller_bare`, `ro_id`, or a date window.
  ⚠️ One to watch: `advisor-board.html:7533` (the Desk) selects unresolved
  `quoted_callback`/`dropping_off` calls with no limit — bounded only by the crew resolving them.
- `api/ctm-webhook.js:313` uses the `_l10` columns **plus `limit=2`** — correct there, because
  the webhook only runs where that migration has been applied.

**FIX ONLY `lookupPhone` shipped in this commit** — the rest is reported for a decision.

## 6. What else happens when an RO is minted (2026-08-22)
`mintRo` is unchanged by the per-RO photo-bucket slice and does not know about it — but a repair
order now has a **DB-side side effect** at insert, and anyone reading this file looking for
"everything that happens when an RO is created" needs to know it exists:

**`trg_repair_orders_photo_buckets`** (`after insert … for each row`) copies the shop's standard
photo buckets from `photo_bucket_templates` onto the new RO. Comebacks, the legacy 5xxx PO
override and hand-run SQL all get it, because it is on the table rather than in this wizard.
Full reasoning — including why it is not a second write inside `mintRo` — is [[ro-photos]] §1c.

⚠ Not applied to any database yet as of 2026-08-22.

## Known gaps & open questions (as of 2026-08-18)
- The vehicle guard cannot catch a duplicate typed with **no VIN and a different plate** —
  nothing links the two rows. Measured cost: 4 rows in the whole table have neither identifier.
- The `completed_jobs` rollups (§5) are the highest-value survivors: they produce **totals**, so
  truncation is invisible rather than merely ugly. Not fixed.
- **RESOLVED (verified `bea25cf`):** the comeback question is gated on a **prior RO for that exact
  vehicle** existing — no prior → no question, by design (see step 2 above). Intended, not a bug.
  Corollary: a returning customer bringing a **new** vehicle gets no comeback question.
- **UX idea (parked):** the legacy-PO field is a plain number entry — a recent-RO picker
  would help.

## Where it lives in the code
- `advisor-board.html` — wizard steps array (~2837), `selectExistingVehicle` (~3011),
  `goToMint` (~3046), legacy-PO field (~1720) + mint write (~3265)
- **Two entry points** into the wizard, both going through `openModal`: the RO Board's
  `+ New RO` button (`cdRoNewBtn` → `window.cdOpenNewRo`, step 1 empty); and the **customer
  record's `+ New RO`** button (`window.cdOpenNewRoForPhone`, which prefills step 1 with the
  customer's phone and runs `lookupPhone` — see [[customer-record]] §4d).
- ⚠ **`window.cdOpenCustomerByPhone` does NOT open this wizard**, despite a comment near
  `cdOpenNewRo` that said so until 2026-09-04. The name is assigned twice in `advisor-board.html`
  and the customer IIFE's later assignment — which opens the customer RECORD — always wins. The
  Desk, call-log rows and phone chips all use it for exactly that. The wizard's phone-prefill
  opener was renamed `cdOpenNewRoForPhone` so the two can no longer collide.
- **Phone lookup (§4):** `shared/phone-lookup.js` (`last10`, `ilikePatternFor`, `phoneOrFilter`,
  `matchesLast10`, `confirmPhoneMatches`), tested by `shared/phone-lookup.test.js` (12 tests).
  Board side: `lookupPhone` in `advisor-board.html`.
- **Duplicate guard (§3):** `shared/vehicle-match.js` (`normVin`/`normPlate`/`normMakeModel`,
  `findVehicleMatch`, `shouldPromptForMatch`, `pickBestMatch`, `matchReasonLabel`), tested by
  `shared/vehicle-match.test.js` (16 tests). Board side: `saveVehicle`'s pre-insert check,
  `showVehMatch` / `clearVehMatch` / `vehMatchAcked`, `state.customerVehicles` (filled by
  `renderCustomerVehicles`), the `#cdVehMatch` panel and `.cd-veh-match*` CSS.
- **`saveVehicle` is the ONLY place a vehicle row is inserted** — verified 2026-08-18 across
  `*.html`, `shared/*.js` and `api/*.js`. The other `from('vehicles')` calls are four selects and
  one field-level update on an existing `vehicle_id`.

## Session change log
- 2026-08-18 — **FIXED the phone lookup's 1,000-row blindness** (§4) and **audited every
  unbounded read** (§5). `lookupPhone` now filters server-side with an end-anchored ilike pattern
  over both phone columns, re-checked on exact last-10 in the client — no dependency on the
  sandbox-only `_l10` columns. Verified: JOSE RAMIREZ (the last row in the table) resolves, a
  formatted-storage customer outside the old 1,000 resolves to its duplicate pair, an unknown
  number still creates. The query pulls 2 rows instead of 1,000. New module + 12 tests. The
  row-cap hazard is now written up in the File Cabinet README so it can't be reintroduced.
- 2026-08-18 — **Added the vehicle duplicate guard** (§3). `saveVehicle` now matches the typed
  vehicle against that customer's existing rows before inserting — VIN, then normalized plate,
  then make+model — and gates the insert on a VIN or plate hit, showing the match inline with its
  RO count and [Use that vehicle] / [No, this is a different vehicle]. A make+model-only match
  saves silently on purpose (the fleet failure mode). New pure module + 16 tests. Also recorded
  the `lookupPhone` 1,000-row ceiling found while testing (see Known gaps) — not fixed.
- 2026-07-30 — Stub created.
- 2026-07-30 — Verified vs `bea25cf`: documented the real step order (added the `cdStepComeback` step
  the stub omitted), confirmed the legacy-PO behavior, and resolved the comeback-question VERIFY
  (intended vehicle-scoped gating).
- 2026-08-22 — **§6 added.** `mintRo` itself is untouched, but creating a repair order now fires
  an `after insert` trigger that copies the standard photo buckets onto it ([[ro-photos]] §1c).
  Recorded here so "what happens when an RO is minted" stays answerable from this file. Nothing
  else in this doc was re-verified this session.
