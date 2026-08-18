# How the intake wizard (New RO flow) is wired

> Doc: `/docs/wiring/intake-wizard.md`
> Last updated: 2026-08-18 — verified vs branch `feat/vehicle-dup-guard` (base `3d61620`)
> (§3 added: the vehicle duplicate guard on `saveVehicle`. §1–§2 unchanged from `bea25cf`.)
> Status: ✅ verified — the guard driven end-to-end in the wizard against the sandbox with every
> write intercepted: prompt on a VIN re-type, "Use that vehicle" reaches the comeback step with
> zero writes, "different vehicle" inserts, and a make+model-only save stays silent.
> Still partial — the customer/phone-match steps aren't fully documented (but see the ⚠️ in
> Known gaps: the phone lookup has a hard 1,000-row ceiling).

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

## Known gaps & open questions (as of 2026-08-18)
- ⚠️ **`lookupPhone` only sees the FIRST 1,000 customers.** It does an unbounded
  `db.from('customers').select(...)`, which PostgREST caps at 1,000 rows — the table has **2,717**.
  So ~63% of customers cannot be found by phone in the wizard and fall through to the
  **create-new-customer** step. That is a duplicate-CUSTOMER generator, and it is why
  `JOSE RAMIREZ` (813-590-9459) cannot be reached through the wizard at all today. Fix is to page
  like `window.cdFetchAllCustomers` does, or to filter server-side. **Found 2026-08-18, not fixed
  — out of scope for the vehicle guard.** Related: [[customer-dedupe]] §5.
- The guard cannot catch a duplicate typed with **no VIN and a different plate** — nothing links
  the two rows. Measured cost: 4 rows in the whole table have neither identifier.
- **RESOLVED (verified `bea25cf`):** the comeback question is gated on a **prior RO for that exact
  vehicle** existing — no prior → no question, by design (see step 2 above). Intended, not a bug.
  Corollary: a returning customer bringing a **new** vehicle gets no comeback question.
- **UX idea (parked):** the legacy-PO field is a plain number entry — a recent-RO picker
  would help.

## Where it lives in the code
- `advisor-board.html` — wizard steps array (~2837), `selectExistingVehicle` (~3011),
  `goToMint` (~3046), legacy-PO field (~1720) + mint write (~3265)
- **Duplicate guard (§3):** `shared/vehicle-match.js` (`normVin`/`normPlate`/`normMakeModel`,
  `findVehicleMatch`, `shouldPromptForMatch`, `pickBestMatch`, `matchReasonLabel`), tested by
  `shared/vehicle-match.test.js` (16 tests). Board side: `saveVehicle`'s pre-insert check,
  `showVehMatch` / `clearVehMatch` / `vehMatchAcked`, `state.customerVehicles` (filled by
  `renderCustomerVehicles`), the `#cdVehMatch` panel and `.cd-veh-match*` CSS.
- **`saveVehicle` is the ONLY place a vehicle row is inserted** — verified 2026-08-18 across
  `*.html`, `shared/*.js` and `api/*.js`. The other `from('vehicles')` calls are four selects and
  one field-level update on an existing `vehicle_id`.

## Session change log
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
