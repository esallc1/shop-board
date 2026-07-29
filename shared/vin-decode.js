/* ============================================================
   vin-decode.js — the ONE VIN-decode implementation.

   NHTSA vPIC DecodeVinValues (no key, CORS-open). The New RO wizard AND the RO
   detail both call this — there is no second copy of the endpoint, the parsing,
   or the no-match/error handling. Pure helpers are exported so the field mapping
   is locked by a test; decodeVinRemote does the fetch and returns a structured
   { status, fields, message } the callers apply however their UI needs.

   No DOM. Loaded in the browser as an ES module that assigns window.VinDecode,
   and imported directly by shared/vin-decode.test.js.
   ============================================================ */

export const NHTSA_ENDPOINT = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';

export function nhtsaUrl(vin) {
  return `${NHTSA_ENDPOINT}/${encodeURIComponent(vin)}?format=json`;
}

// "VOLKSWAGEN" → "Volkswagen". Verbatim from advisor-board's old titleCase.
export function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
}

// NHTSA DriveType free text → the drive_type enum the app stores. Verbatim from
// advisor-board's old mapDriveType.
export function mapDriveType(v) {
  const s = (v || '').toUpperCase();
  if (s.includes('FWD') || s.includes('FRONT')) return 'FWD';
  if (s.includes('RWD') || s.includes('REAR')) return 'RWD';
  if (s.includes('AWD') || s.includes('ALL-WHEEL') || s.includes('ALL WHEEL')) return 'AWD';
  if (s.includes('4WD') || s.includes('4X4') || s.includes('4-WHEEL') || s.includes('FOUR')) return '4WD';
  return '';
}

// The exact "no clean match" test the wizard used: an error code AND no make or
// model. A partial decode that still returns a make/model is NOT a no-match.
export function isNoMatch(r) {
  return !!(r && r.ErrorCode && r.ErrorCode !== '0' && !r.Make && !r.Model);
}

// Parse an NHTSA Results[0] object into the fields the app stores. Empty string
// where NHTSA gave nothing (so callers can "fill only where decoded"). Verbatim
// field mapping from the wizard's old decodeVin.
export function decodeVinFields(r) {
  const o = r || {};
  const engine = [
    o.DisplacementL ? (Number(o.DisplacementL).toFixed(1) + 'L') : '',
    o.EngineCylinders ? (o.EngineCylinders + '-cyl') : '',
    (o.FuelTypePrimary && o.FuelTypePrimary !== 'Gasoline') ? o.FuelTypePrimary : '',
  ].filter(Boolean).join(' ');
  return {
    year: o.ModelYear || '',
    make: o.Make ? titleCase(o.Make) : '',
    model: o.Model ? titleCase(o.Model) : '',
    engine,
    drive: mapDriveType(o.DriveType),
  };
}

// Decide how to apply decoded fields over the current values, WITHOUT ever
// silently clobbering a differing hand-entered value. For each of
// year/make/model/engine that NHTSA decoded:
//   • current empty  → a "fill" (apply directly)
//   • current equals decoded (case-insensitive) → nothing
//   • current differs → a "conflict" (the caller must ask before replacing)
// Pure + exported so the no-silent-overwrite rule is locked by a test.
export const APPLY_FIELDS = ['year', 'make', 'model', 'engine'];
export function planDecodeApply(current, decoded) {
  const cur = current || {}, dec = decoded || {};
  const fills = [], conflicts = [];
  for (const field of APPLY_FIELDS) {
    const value = dec[field];
    if (!value) continue;                                   // NHTSA gave nothing for this field
    const have = cur[field] == null ? '' : String(cur[field]).trim();
    if (!have) fills.push({ field, value });
    else if (have.toLowerCase() !== String(value).toLowerCase()) conflicts.push({ field, current: have, value });
    // equal → no-op
  }
  return { fills, conflicts };
}

// Decode a VIN against NHTSA. Returns one of:
//   { status:'bad-vin',  message }                    — not 17 chars
//   { status:'no-match', message }                    — decoded, but no clean match
//   { status:'error',    message, error }             — network / HTTP failure
//   { status:'ok',       message, fields }            — decoded; fields = decodeVinFields
// The messages are the SAME strings the wizard has always shown. fetchFn is
// injectable for testing; defaults to the global fetch in the browser.
export async function decodeVinRemote(vin, opts) {
  const doFetch = (opts && opts.fetchFn) || (typeof fetch !== 'undefined' ? fetch : null);
  const v = String(vin == null ? '' : vin).trim().toUpperCase();
  if (v.length !== 17) return { status: 'bad-vin', message: 'VIN must be 17 characters.' };
  let json;
  try {
    const resp = await doFetch(nhtsaUrl(v));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    json = await resp.json();
  } catch (err) {
    return { status: 'error', message: 'Decode failed (' + ((err && err.message) || 'network') + ') — enter manually.', error: err };
  }
  const r = (json && json.Results && json.Results[0]) || {};
  if (isNoMatch(r)) return { status: 'no-match', message: 'NHTSA had no clean match — fill in manually.' };
  const fields = decodeVinFields(r);
  const got = [fields.year, fields.make, fields.model].filter(Boolean).join(' ');
  return {
    status: 'ok',
    fields,
    message: got ? `Decoded: ${got}. Confirm transmission code by hand.` : 'Decoded — confirm fields.',
  };
}
