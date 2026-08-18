/* ============================================================
   vehicle-match.test.js — unit tests for the intake duplicate guard.
   Run: npm test   (node --test)

   These lock the decisions that were taken deliberately:
     • matching is CUSTOMER-SCOPED — the module never sees another customer's
       rows, and the tests assert it only ever returns what it was handed;
     • order is VIN → plate → make+model;
     • a make+model-only match is NOT prompt-worthy (the fleet failure mode);
     • the ALLDATA trailing " 00" never defeats a plate match;
     • the row offered is the one carrying the history, not the newest.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_VIN_LEN, normVin, usableVin, normPlate, normMakeModel,
  findVehicleMatch, shouldPromptForMatch, pickBestMatch, matchReasonLabel,
} from './vehicle-match.js';

// JOSE RAMIREZ's real pair, verbatim from the sandbox. The 07-27 row was typed
// into CrisData and carries the RO; the 07-28 row arrived with the ALLDATA
// import, has no year, and reads "No visits".
const JOSE_TYPED  = { id: 'v-typed',  year: 1993, make: 'Chevrolet', model: 'c1500', vin: '1GBDC14K9PZ109240', plate: 'GR239' };
const JOSE_IMPORT = { id: 'v-import', year: null, make: 'Chevrolet', model: 'C1500', vin: '1GBDC14K9PZ109240', plate: 'GR239' };
const JOSE = [JOSE_IMPORT, JOSE_TYPED];        // created_at DESC — the empty row comes first

// ── normalizers ──────────────────────────────────────────────
test('normVin uppercases and strips punctuation', () => {
  assert.equal(normVin('1gbdc14k9pz109240'), '1GBDC14K9PZ109240');
  assert.equal(normVin(' 1GBDC14K9-PZ109240 '), '1GBDC14K9PZ109240');
  assert.equal(normVin(null), '');
  assert.equal(usableVin('1GBDC14K9PZ109240'), true);
  assert.equal(usableVin('SHORT'), false);
  assert.equal(usableVin(null), false);
  assert.equal(MIN_VIN_LEN, 11);
});

test('normPlate strips the ALLDATA trailing " 00" — and only that form', () => {
  assert.equal(normPlate('GR239 00'), 'GR239');
  assert.equal(normPlate('GR239'), 'GR239');
  assert.equal(normPlate('X1267 00'), 'X1267');
  assert.equal(normPlate('gr239 00'), 'GR239');
  // A genuine plate that just happens to end in 00, with no space, is untouched.
  assert.equal(normPlate('ABC00'), 'ABC00');
  assert.equal(normPlate(null), '');
  assert.equal(normPlate('  '), '');
});

test('normPlate strips the suffix BEFORE punctuation — order matters', () => {
  // Strip punctuation first and "GR239 00" becomes "GR23900", which would never
  // match "GR239". This is the bug the ordering exists to prevent.
  assert.equal(normPlate('GR239 00'), normPlate('GR239'));
});

test('normMakeModel is case/space-insensitive and needs BOTH halves', () => {
  assert.equal(normMakeModel({ make: 'Chevrolet', model: 'c1500' }), 'chevrolet c1500');
  assert.equal(normMakeModel({ make: 'CHEVROLET', model: 'C1500' }), 'chevrolet c1500');
  assert.equal(normMakeModel({ make: 'Ford', model: '  Transit  Connect ' }), 'ford transit connect');
  assert.equal(normMakeModel({ make: 'Ford', model: null }), '', 'model alone is not a key');
  assert.equal(normMakeModel({ make: null, model: 'F-150' }), '', 'make alone is not a key');
  assert.equal(normMakeModel(null), '');
});

// ── the Jose case, end to end ────────────────────────────────
test('THE JOSE CASE: re-typing the truck matches on VIN, across the year gap', () => {
  const m = findVehicleMatch(JOSE, { year: 1993, make: 'Chevrolet', model: 'C1500', vin: '1GBDC14K9PZ109240', plate: 'GR239' });
  assert.equal(m.on, 'vin');
  assert.equal(m.matches.length, 2, 'both rows of the duplicate group match');
  assert.equal(shouldPromptForMatch(m), true);
});

test('THE JOSE CASE: it still matches when the advisor omits the year entirely', () => {
  const m = findVehicleMatch(JOSE, { year: null, make: 'Chevrolet', model: 'C1500', vin: '1GBDC14K9PZ109240' });
  assert.equal(m.on, 'vin');
  assert.equal(shouldPromptForMatch(m), true);
});

test('THE JOSE CASE: the prompt offers the row with the RO, not the newest', () => {
  // JOSE[0] is the empty import row. Offering that one would send the advisor
  // to the phantom twin — the exact failure this guard exists to undo.
  const roCount = (v) => (v.id === 'v-typed' ? 1 : 0);
  assert.equal(pickBestMatch(JOSE, roCount).id, 'v-typed');
  assert.equal(pickBestMatch(JOSE, () => 0).id, 'v-import', 'no history anywhere → keep caller order');
  assert.equal(pickBestMatch([], roCount), null);
  assert.equal(pickBestMatch(null, roCount), null);
});

// ── match ORDER ──────────────────────────────────────────────
test('VIN wins over plate, and plate wins over make+model', () => {
  const vehicles = [
    { id: 'by-mm',    make: 'Ford', model: 'F-150', vin: null, plate: null },
    { id: 'by-plate', make: 'Ram',  model: '1500',  vin: null, plate: 'AAA111' },
    { id: 'by-vin',   make: 'Ram',  model: '2500',  vin: '1GBDC14K9PZ109240', plate: 'ZZZ999' },
  ];
  assert.equal(findVehicleMatch(vehicles, { vin: '1GBDC14K9PZ109240', plate: 'AAA111', make: 'Ford', model: 'F-150' }).matches[0].id, 'by-vin');
  assert.equal(findVehicleMatch(vehicles, { vin: null, plate: 'AAA111', make: 'Ford', model: 'F-150' }).matches[0].id, 'by-plate');
  assert.equal(findVehicleMatch(vehicles, { vin: null, plate: null, make: 'Ford', model: 'F-150' }).matches[0].id, 'by-mm');
});

test('a VIN too short to trust falls through to the next key', () => {
  const vehicles = [{ id: 'v1', vin: 'ABC', plate: 'AAA111', make: 'Ram', model: '1500' }];
  const m = findVehicleMatch(vehicles, { vin: 'ABC', plate: 'AAA111', make: 'Ram', model: '1500' });
  assert.equal(m.on, 'plate', 'a 3-char VIN is junk, not a key');
});

test('plate match survives the import suffix on EITHER side', () => {
  assert.equal(findVehicleMatch([{ id: 'v1', plate: 'X1267 00' }], { plate: 'X1267' }).on, 'plate');
  assert.equal(findVehicleMatch([{ id: 'v1', plate: 'X1267' }], { plate: 'X1267 00' }).on, 'plate');
  assert.equal(findVehicleMatch([{ id: 'v1', plate: 'X1267 00' }], { plate: 'X1267 00' }).on, 'plate');
});

// ── the fleet failure mode — the decision that matters most ──
test('a make+model-only match is NEVER prompt-worthy (the fleet failure mode)', () => {
  // Mint Motors: eleven "Ford Transit Connect" rows, ten distinct VINs. They are
  // eleven real vans. Prompting here would fire on every fleet intake and train
  // the crew to click through the prompt — making it worthless when it is right.
  const FLEET = Array.from({ length: 11 }, (_, i) => ({
    id: 'van-' + i, make: 'Ford', model: 'Transit Connect', vin: 'NM0LS7BN6CT11685' + i, plate: 'X' + (100 + i) + ' 00',
  }));
  const m = findVehicleMatch(FLEET, { make: 'Ford', model: 'Transit Connect', vin: null, plate: null });
  assert.equal(m.on, 'make_model');
  assert.equal(m.matches.length, 11, 'the match is still reported…');
  assert.equal(shouldPromptForMatch(m), false, '…but it must NOT be a question');
});

test('a twelfth fleet van WITH its own VIN does not match the others at all', () => {
  const FLEET = [{ id: 'van-a', make: 'Ford', model: 'Transit Connect', vin: 'NM0LS7BN6CT116859', plate: 'X101 00' }];
  const m = findVehicleMatch(FLEET, { make: 'Ford', model: 'Transit Connect', vin: 'NM0LS7FX6G1261557', plate: 'X102 00' });
  // A real new van: different VIN, different plate. Falls through to make+model,
  // which is reported but not prompted — so it saves silently. Correct.
  assert.equal(m.on, 'make_model');
  assert.equal(shouldPromptForMatch(m), false);
});

// ── no match ─────────────────────────────────────────────────
test('a genuinely new vehicle matches nothing', () => {
  assert.equal(findVehicleMatch(JOSE, { vin: '1FTFW1ET5DFC10312', plate: 'NEW999', make: 'Ford', model: 'F-150' }), null);
  assert.equal(findVehicleMatch([], { vin: '1GBDC14K9PZ109240' }), null);
  assert.equal(findVehicleMatch(null, { vin: '1GBDC14K9PZ109240' }), null);
  assert.equal(findVehicleMatch(JOSE, null), null);
  assert.equal(findVehicleMatch(JOSE, {}), null, 'nothing typed → nothing matched');
});

test('the module only ever returns rows it was handed (customer scoping is the caller\'s job)', () => {
  // The guard is customer-scoped because the CALLER passes one customer's
  // vehicles. 35 VINs in the table sit under 2+ customers, so a global rule
  // would be wrong; this asserts the module adds nothing of its own.
  const m = findVehicleMatch(JOSE, { vin: '1GBDC14K9PZ109240' });
  m.matches.forEach((v) => assert.ok(JOSE.includes(v), 'every match is an input row'));
});

test('shouldPromptForMatch is false for null / unknown kinds', () => {
  assert.equal(shouldPromptForMatch(null), false);
  assert.equal(shouldPromptForMatch({ on: 'something-else' }), false);
});

test('matchReasonLabel names the key that hit', () => {
  assert.equal(matchReasonLabel('vin'), 'same VIN');
  assert.equal(matchReasonLabel('plate'), 'same plate');
  assert.equal(matchReasonLabel('make_model'), 'same make and model');
  assert.equal(matchReasonLabel(undefined), '');
});
