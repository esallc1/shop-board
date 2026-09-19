/* ============================================================
   warranty-presets.js — THE "Warranty given" presets for an RO. One file.

   repair_orders.warranty_terms (migrations/20260919_ro_warranty_terms_*.sql)
   holds the warranty the shop is GIVING the customer, as FULL TEXT — exactly
   the words that print on the estimate / RO / invoice (shared/ro-invoice.js).
   A preset only fills the box; the advisor can edit it and add custom text.
   The TEXT is what's saved, never a preset name, so rewording a preset here
   later never changes a document a customer already has.

   NOT the "Warranty / Comeback" switch (that marks a visit as comeback work,
   lives on the floor row, and never prints) — see ro-invoice.md §5.

   The wording below was approved word-for-word by Cris (2026-09-19). Changing
   it needs his OK. `vendor: true` = the manufacturer's (third-party) warranty:
   the RO detail shows an on-screen warning to confirm the supplier's terms
   (never printed). Kevin's "1 Year parts & labor" is deliberately NOT a
   preset — custom text covers it.

   No DOM. Loaded in the browser as an ES module that assigns
   window.WarrantyPresets and imported directly by warranty-presets.test.js.
   ============================================================ */

// Order = picker order. `label` is the short picker text (UI only, never saved
// or printed); `text` is the approved wording that goes into the box.
export const WARRANTY_PRESETS = Object.freeze([
  Object.freeze({
    id: 'rebuild-1y-12k',
    label: 'Transmission Rebuild — 1 yr / 12,000 mi',
    text: 'Transmission Rebuild — 1 year or 12,000 miles parts & labor warranty, whichever comes first.',
    vendor: false,
  }),
  Object.freeze({
    id: 'reman-3y-100k',
    label: 'Reman — 3 yr / 100,000 mi (manufacturer)',
    text: "Remanufactured Transmission — 3 years or 100,000 miles parts & labor warranty, whichever comes first, provided by the unit's manufacturer.",
    vendor: true,
  }),
  Object.freeze({
    id: 'reman-3y-unlimited',
    label: 'Reman — 3 yr / unlimited mi (manufacturer)',
    text: "Remanufactured Transmission — 3 years / unlimited miles parts & labor warranty, provided by the unit's manufacturer.",
    vendor: true,
  }),
  Object.freeze({
    id: 'customer-parts',
    label: 'Customer-provided parts — no warranty',
    text: 'Customer-provided parts — no warranty can be given on this repair.',
    vendor: false,
  }),
  Object.freeze({
    id: 'declined-repair',
    label: 'Customer declined repair — no warranty',
    text: 'Customer declined the recommended repair — no warranty can be given on the work performed.',
    vendor: false,
  }),
  Object.freeze({
    id: 'comeback-original',
    label: 'Comeback — original warranty stands',
    text: 'Comeback — the original warranty still stands.',
    vendor: false,
  }),
]);

// On-screen only (never printed), shown while the box holds a vendor preset.
export const VENDOR_WARNING = "⚠ Vendor warranty — confirm this supplier's exact terms before putting it on the invoice.";

// Must match the CHECK in migrations/20260919_ro_warranty_terms_*.sql
// (warranty-presets.test.js reads both files and fails if they drift).
export const MAX_WARRANTY_LEN = 2000;

export function presetById(id) {
  return WARRANTY_PRESETS.find((p) => p.id === id) || null;
}

// "Insert preset…": an empty box gets the preset; a box that already has text
// keeps it and gets the preset on a NEW line (trailing blank lines/spaces of the
// existing text are dropped first, so there's never a gap). Picking the same
// preset twice adds it twice — the box is plain text and always editable.
export function insertPreset(current, presetText) {
  const add = String(presetText == null ? '' : presetText).trim();
  const cur = String(current == null ? '' : current).replace(/\s+$/, '');
  if (!add) return cur;
  if (!cur.trim()) return add;
  return cur + '\n' + add;
}

// True while the box contains any vendor preset's text → show VENDOR_WARNING.
// Content-based, so it shows the moment such a preset is picked AND again
// when the RO is reopened; it goes away if the advisor deletes that text.
export function hasVendorWarranty(text) {
  const t = String(text == null ? '' : text);
  return WARRANTY_PRESETS.some((p) => p.vendor && t.includes(p.text));
}

// The box → what is written to repair_orders.warranty_terms.
//   blank → { ok: true, value: null }  (nothing prints)
//   too long → { ok: false, reason: 'too-long', max }  (the DB would reject it)
// Line breaks are kept (they print); only outer whitespace is trimmed and
// Windows line endings are normalised.
export function warrantyForSave(text) {
  const v = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!v) return { ok: true, value: null };
  if (v.length > MAX_WARRANTY_LEN) return { ok: false, reason: 'too-long', max: MAX_WARRANTY_LEN, length: v.length };
  return { ok: true, value: v };
}
