/* ============================================================
   vin-decode.test.js — unit tests for the single VIN-decode implementation.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleCase, mapDriveType, isNoMatch, decodeVinFields, decodeVinRemote, nhtsaUrl, planDecodeApply } from './vin-decode.js';

// A clean Tiguan-shaped Results[0], matching what NHTSA returns for
// WVGBV7AXXGW533510 (RO #6014).
const TIGUAN = {
  ModelYear: '2016', Make: 'VOLKSWAGEN', Model: 'Tiguan', ErrorCode: '0',
  DisplacementL: '2', EngineCylinders: '4', FuelTypePrimary: 'Gasoline', DriveType: '',
};

test('titleCase normalizes NHTSA all-caps', () => {
  assert.equal(titleCase('VOLKSWAGEN'), 'Volkswagen');
  assert.equal(titleCase('FORD F-150'), 'Ford F-150');
  assert.equal(titleCase(''), '');
});

test('mapDriveType maps NHTSA drive strings to the enum', () => {
  assert.equal(mapDriveType('FWD/Front-Wheel Drive'), 'FWD');
  assert.equal(mapDriveType('4WD/4-Wheel Drive'), '4WD');
  assert.equal(mapDriveType('AWD/All-Wheel Drive'), 'AWD');
  assert.equal(mapDriveType(''), '');
});

test('isNoMatch: error code AND no make/model → true; a clean or partial decode → false', () => {
  assert.equal(isNoMatch({ ErrorCode: '1', Make: '', Model: '' }), true);
  assert.equal(isNoMatch({ ErrorCode: '0', Make: 'VOLKSWAGEN', Model: 'Tiguan' }), false);
  assert.equal(isNoMatch({ ErrorCode: '11', Make: 'FORD', Model: '' }), false); // partial still usable
  assert.equal(isNoMatch({}), false);
});

test('decodeVinFields maps Results[0] to stored fields (title-cased, formatted engine)', () => {
  assert.deepEqual(decodeVinFields(TIGUAN), {
    year: '2016', make: 'Volkswagen', model: 'Tiguan', engine: '2.0L 4-cyl', drive: '',
  });
});

test('decodeVinFields leaves empty strings where NHTSA gave nothing', () => {
  const f = decodeVinFields({ Make: 'HONDA' });
  assert.equal(f.make, 'Honda');
  assert.equal(f.year, '');
  assert.equal(f.model, '');
  assert.equal(f.engine, '');
});

// ── decodeVinRemote (fetch injected) ────────────────────────
const okFetch = (body) => async () => ({ ok: true, json: async () => body });

test('decodeVinRemote rejects a non-17-char VIN without fetching', async () => {
  let called = 0;
  const res = await decodeVinRemote('SHORT', { fetchFn: async () => { called++; return { ok: true, json: async () => ({}) }; } });
  assert.deepEqual(res, { status: 'bad-vin', message: 'VIN must be 17 characters.' });
  assert.equal(called, 0);
});

test('decodeVinRemote: a good VIN → ok + fields + the decoded message', async () => {
  const res = await decodeVinRemote('WVGBV7AXXGW533510', { fetchFn: okFetch({ Results: [TIGUAN] }) });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.fields, { year: '2016', make: 'Volkswagen', model: 'Tiguan', engine: '2.0L 4-cyl', drive: '' });
  assert.equal(res.message, 'Decoded: 2016 Volkswagen Tiguan. Confirm transmission code by hand.');
});

test('decodeVinRemote: no clean match → no-match message, no fields', async () => {
  const res = await decodeVinRemote('11111111111111111', { fetchFn: okFetch({ Results: [{ ErrorCode: '1', Make: '', Model: '' }] }) });
  assert.equal(res.status, 'no-match');
  assert.equal(res.message, 'NHTSA had no clean match — fill in manually.');
  assert.ok(!('fields' in res));
});

test('decodeVinRemote: network throw → error message', async () => {
  const res = await decodeVinRemote('WVGBV7AXXGW533510', { fetchFn: async () => { throw new Error('boom'); } });
  assert.equal(res.status, 'error');
  assert.equal(res.message, 'Decode failed (boom) — enter manually.');
});

test('decodeVinRemote: HTTP non-ok → error message', async () => {
  const res = await decodeVinRemote('WVGBV7AXXGW533510', { fetchFn: async () => ({ ok: false, status: 503 }) });
  assert.equal(res.status, 'error');
  assert.equal(res.message, 'Decode failed (HTTP 503) — enter manually.');
});

// ── planDecodeApply: never silently overwrite ──────────────
test('planDecodeApply fills empty fields and flags differing ones as conflicts', () => {
  const current = { year: '', make: 'Toyota', model: '', engine: '2.0L 4-cyl' };  // make differs, engine matches
  const decoded = { year: '2016', make: 'Volkswagen', model: 'Tiguan', engine: '2.0L 4-cyl' };
  const { fills, conflicts } = planDecodeApply(current, decoded);
  assert.deepEqual(fills, [{ field: 'year', value: '2016' }, { field: 'model', value: 'Tiguan' }]);  // empties filled
  assert.deepEqual(conflicts, [{ field: 'make', current: 'Toyota', value: 'Volkswagen' }]);          // differing → conflict, NOT auto-applied
  // engine matched → neither filled nor conflicted (no needless write)
  assert.ok(!fills.some(f => f.field === 'engine') && !conflicts.some(c => c.field === 'engine'));
});

test('planDecodeApply proposes nothing to fill/clobber when everything already matches', () => {
  const same = { year: '2016', make: 'Volkswagen', model: 'Tiguan', engine: '2.0L 4-cyl' };
  assert.deepEqual(planDecodeApply(same, same), { fills: [], conflicts: [] });
});

test('planDecodeApply ignores fields NHTSA did not decode (blank decoded → no proposal)', () => {
  const { fills, conflicts } = planDecodeApply({ year: '', make: 'Ford' }, { year: '', make: '', model: 'Focus' });
  assert.deepEqual(fills, [{ field: 'model', value: 'Focus' }]);   // only the one NHTSA gave
  assert.deepEqual(conflicts, []);                                  // blank decoded make never conflicts with 'Ford'
});

test('nhtsaUrl builds the DecodeVinValues endpoint', () => {
  assert.equal(nhtsaUrl('WVGBV7AXXGW533510'),
    'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/WVGBV7AXXGW533510?format=json');
});
