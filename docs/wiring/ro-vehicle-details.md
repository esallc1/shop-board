# How the RO's "Vehicle & reference details" box is wired

> Doc: `/docs/wiring/ro-vehicle-details.md`
> Last updated: 2026-09-18 — verified vs commit `399e93c` (branch
> `feat/customer-edit-transmission`, UNMERGED — on staging only), which added the **Transmission**
> field. Every claim below was checked against `advisor-board.html` / `shared/vin-decode.js` /
> `shared/ro-invoice.js` this session.
> Status: ✅ Transmission driven in a real browser on `test.*` (see change log); the rest of the
> box is described from code, not re-driven.

## 0. In one line
A collapsed `<details>` box on the RO detail page (`advisor-board.html`, under
`#cdRoHeaderGrid`) where the advisor corrects the car's facts after the intake wizard:
odometer in/out (saved on the **RO**) and plate, plate state, VIN, year, make, model, engine and
**transmission** (saved on the shared **vehicle** row), plus Decode VIN and Copy VIN buttons.

## 1. Two homes: RO fields vs vehicle fields
- **Odometer In / Miles Out** (`#cdRoOdometerIn`, `#cdRoMilesOut`) belong to *this visit* →
  `repair_orders.odometer_in` / `miles_out` via `updateRoField` (integer-coerced).
- **Plate, Plate State, VIN, Year, Make, Model, Engine, Transmission** belong to *the car* →
  the `vehicles` row via `updateVehicleField(field, value)`:
  `db.from('vehicles').update({ [field]: value }).eq('id', currentRo.vehicle_id)`.
  **Ripple is intended:** the vehicle row is shared by every RO for that car, so a correction
  here shows on all of them.
- Both savers are **silent and optimistic**: fire on `change` (blur/enter), patch `currentRo`
  in memory first, and only `console.error` on failure — no alert, no spinner. Blank → `NULL`.

## 2. The fields (`openRo` fills them; the listeners save them)
| Label | Input | Column | Notes |
|---|---|---|---|
| Plate / Plate State / VIN | `#cdRoPlate` / `#cdRoPlateState` / `#cdRoVin` | `vehicles.plate` / `plate_state` / `vin` | text, trimmed |
| Year | `#cdRoYear` | `vehicles.year` | int column — `parseInt`, else `NULL` |
| Make / Model / Engine | `#cdRoMake` / `#cdRoModel` / `#cdRoEngine` | `vehicles.make` / `model` / `engine` | text |
| **Transmission** | **`#cdRoTrans`** | **`vehicles.transmission_code`** | **plain text** (e.g. `62TE`), saved exactly like Engine |

**Transmission lives in ONE place: `vehicles.transmission_code`** (text, since
`20260716_ro_foundation.sql`). No new column was added. The same column is written by the intake
wizard's new-vehicle step (`#cdVehTransCode`) and read by the printed RO/invoice
(`shared/ro-invoice.js`), My Numbers (the tech's RO view), and the bookkeeping RO detail.
Every one of those surfaces now labels it **"Transmission"** (the wizard said "Transmission
Code", the print "Trans code", My Numbers "Trans" — renamed 2026-09-18 so it reads the same
everywhere).

Not to be confused with: **`package_units`** (the rebuilt unit *sold* on a Package line — see
[[packages]]) or the **`transmissions`** catalog behind the manager board's teardown "Transmission
Unit" picker. Neither describes what is in the customer's car.

## 3. Decode VIN (`decodeRoVin`) and the conflict check
`#cdRoDecodeBtn` calls `VinDecode.decodeVinRemote(vin)` (NHTSA) and then
`VinDecode.planDecodeApply(current, decoded)`: **empty** fields are filled and saved directly;
a field that already holds a **different** value is listed in a `confirm()` and only replaced if
the advisor accepts — hand-entered data is never silently overwritten.

`transmission_code` is in the page's `EL` / `LABEL` / `current` maps, so it takes part in that
check — but it is **inert today**: `VinDecode.APPLY_FIELDS` is `year, make, model, engine`, so a
decode never proposes a transmission and can never fill or overwrite the typed value. Filling
the transmission from the VIN is a **separate, later slice**; when it adds `transmission_code` to
`APPLY_FIELDS`, the conflict prompt already covers it.

## 4. Where a change shows up
- **This RO, immediately:** `currentRo.vehicles[field]` is patched before the write, so
  **Print** (`printRo` → `RoInvoice.buildPrintDoc({ ro: currentRo, … })`) shows the new value
  with no reopen. The header's Vehicle line (`renderHeader`) shows `year make model · plate`
  only — not engine or transmission.
- **Everything else** re-reads the vehicle row on its next load (other ROs of the same car, My
  Numbers, bookkeeping).

## Known gaps & open questions (as of 2026-09-18)
- **Silent failure.** A failed vehicle write only logs to the console; the box still shows the
  typed value until the RO is reopened. Same for every field here, not new with Transmission.
- **No VIN → transmission lookup yet** (§3) — by decision, a later slice.
- The wizard's `#cdVehTransCode` is still a free-text box too; there is no catalog/dropdown.

## Where it lives in the code
- Markup: `<details class="cd-ro-disclosure">` "Vehicle &amp; reference details" in
  `advisor-board.html` (inside the RO detail panel, after `#cdRoHeaderGrid`).
- Fill: `openRo` (`$('cdRoEngine').value = …`, `$('cdRoTrans').value = v.transmission_code …`).
  `openRo`'s `EMBEDS` and `loadRoContext` select `vehicles(… engine, … transmission_code, …)`.
- Save: `updateVehicleField`, `updateRoField`; the `change` listeners beside
  `$('cdRoEngine').addEventListener(…)`.
- Decode: `decodeRoVin` + `shared/vin-decode.js` (`APPLY_FIELDS`, `planDecodeApply`,
  `decodeVinRemote`). Copy VIN: `#cdRoVinCopyBtn`.
- Readers of `transmission_code`: `shared/ro-invoice.js` (print/embed), `my-numbers.html`,
  `bookkeeping-board.html` (`RO_COLS`), the wizard's create (`#cdVehTransCode`).

## Session change log
- 2026-09-18 — **Doc created; Transmission field added** next to Engine (`#cdRoTrans` →
  `vehicles.transmission_code` via `updateVehicleField`, joins the decode conflict maps but inert
  there). Labels unified to "Transmission" in the wizard, the print and My Numbers. Branch
  `feat/customer-edit-transmission`, unmerged. **Verified on `test.*` (sandbox):** typed `62TE`
  on RO #6034 (vehicle had none) → `vehicles.transmission_code = '62TE'` in the DB → still there
  after a full reload → the printed estimate's Vehicle block reads **Transmission 62TE** (the
  document `printRo` writes, captured in-page because the browser pane blocks the pop-up).
