/* ============================================================
   vehicle-match.js — PURE matching logic for the intake wizard's duplicate
   guard: does the vehicle the advisor just typed already exist on THIS
   customer?

   WHY IT EXISTS: `saveVehicle` inserted unconditionally, so re-typing a truck
   minted a second row. The real case — JOSE RAMIREZ has "1993 Chevrolet c1500"
   (typed 07-27, carries the RO) and "Chevrolet C1500" (arrived with the ALLDATA
   import 07-28, reads "No visits"), same VIN 1GBDC14K9PZ109240, same plate
   GR239. The history isn't lost, but the record shows a phantom twin.

   Deliberate rules encoded here (do not "fix"):

   - **CUSTOMER-SCOPED, NEVER GLOBAL.** 35 VINs in the table sit under two or
     more customers, and ~23 of those are duplicate CUSTOMERS rather than
     resold cars. A globally-unique VIN rule would be wrong dozens of times and
     would fight the customer-dedupe work instead of helping it. The caller
     passes only that one customer's vehicles.

   - **MATCH ORDER: VIN → plate → make+model.** VIN is the strongest signal
     (77% of rows have a usable one); plate is the broadest (99.5%); make+model
     is the last resort for the 4 rows in the whole table that have neither.

   - **ONLY A VIN OR PLATE MATCH IS PROMPT-WORTHY** (`shouldPromptForMatch`).
     A make+model-only match MUST save silently. On a fleet customer — Mint
     Motors has eleven "Ford Transit Connect" rows with ten distinct VINs —
     a make+model prompt would fire constantly and train the crew to click
     straight through it, which would make the prompt worthless exactly when it
     matters. The match is still reported so the caller can log it; it just
     isn't a question.

   - **The ALLDATA trailing " 00" is normalized OUT of plates on BOTH sides**
     (1,203 rows carry it — "X1267 00", "GR239 00"). We do not repair the stored
     data here; we just refuse to let the import's artifact defeat a match.

   No DOM, no db, no globals. Loaded in the browser as an ES module that assigns
   window.VehicleMatch, and imported directly by shared/vehicle-match.test.js
   under `node --test`.
   ============================================================ */

// A VIN needs this many characters (after stripping) to be worth trusting. Real
// VINs are 17; the table has none between 1 and 16, so this only guards junk.
export const MIN_VIN_LEN = 11;

// VIN key: uppercase, letters+digits only. Handles spaces/dashes someone typed.
export function normVin(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function usableVin(v) {
  return normVin(v).length >= MIN_VIN_LEN;
}

// Plate key. The trailing " 00" comes off FIRST — before the non-alphanumeric
// strip — because order matters: "GR239 00" → strip suffix → "GR239" matches
// "GR239". Stripping punctuation first would give "GR23900" and never match.
// The `\s+` in the pattern is deliberate: only a SPACE-separated "00" is the
// import artifact, so a genuine plate ending in 00 ("ABC00") is left alone.
export function normPlate(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/\s+00$/, '').replace(/[^A-Z0-9]/g, '');
}

// make+model key — lowercase, whitespace collapsed. "c1500" == "C1500".
export function normMakeModel(v) {
  if (!v) return '';
  const make = String(v.make == null ? '' : v.make).toLowerCase().replace(/\s+/g, ' ').trim();
  const model = String(v.model == null ? '' : v.model).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!make || !model) return '';
  return make + ' ' + model;
}

// Find the vehicles on THIS customer that the typed row looks like.
//
// Returns { on: 'vin' | 'plate' | 'make_model', matches: [vehicle, …] } for the
// FIRST key that hits, or null. It returns EVERY vehicle matching that key
// rather than one, on purpose: a duplicate group can have the history on either
// row (Jose's does — the older typed row carries the RO while the newer import
// row is empty), so picking a winner needs the RO counts, which is the caller's
// business, not this module's.
export function findVehicleMatch(vehicles, typed) {
  const list = (vehicles || []).filter(Boolean);
  if (!list.length || !typed) return null;

  const vinKey = normVin(typed.vin);
  if (vinKey.length >= MIN_VIN_LEN) {
    const hit = list.filter((v) => normVin(v.vin) === vinKey);
    if (hit.length) return { on: 'vin', matches: hit };
  }

  const plateKey = normPlate(typed.plate);
  if (plateKey) {
    const hit = list.filter((v) => normPlate(v.plate) === plateKey);
    if (hit.length) return { on: 'plate', matches: hit };
  }

  const mmKey = normMakeModel(typed);
  if (mmKey) {
    const hit = list.filter((v) => normMakeModel(v) === mmKey);
    if (hit.length) return { on: 'make_model', matches: hit };
  }

  return null;
}

// Is this match worth stopping the advisor for? VIN and plate only — see the
// header. A make_model match is real information but NOT a question.
export function shouldPromptForMatch(match) {
  return !!match && (match.on === 'vin' || match.on === 'plate');
}

// Of the matched rows, which one should the prompt offer? The one carrying the
// most history — that is almost always the row the advisor actually wants, and
// it is the one whose absence caused the split in the first place. `roCountOf`
// maps a vehicle to its RO count; ties keep the caller's original order.
export function pickBestMatch(matches, roCountOf) {
  const list = (matches || []).filter(Boolean);
  if (!list.length) return null;
  const count = roCountOf || (() => 0);
  let best = list[0];
  let bestN = Number(count(best)) || 0;
  for (let i = 1; i < list.length; i++) {
    const n = Number(count(list[i])) || 0;
    if (n > bestN) { best = list[i]; bestN = n; }
  }
  return best;
}

// Human phrase for what matched, used in the prompt so the advisor can see WHY
// this row was surfaced.
export function matchReasonLabel(on) {
  if (on === 'vin') return 'same VIN';
  if (on === 'plate') return 'same plate';
  if (on === 'make_model') return 'same make and model';
  return '';
}
