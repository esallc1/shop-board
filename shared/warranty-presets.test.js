/* ============================================================
   warranty-presets.test.js — the "Warranty given" presets + box rules.
   Run: npm test   (node --test)

   Locks: the six presets are Cris's approved wording, verbatim and in order;
   the vendor flag is data (presets 2 + 3 only); "Insert preset…" fills an empty
   box and APPENDS on a new line otherwise; the full text is what's saved; the
   length cap matches both migrations' CHECK; the advisor board has no inline
   copy of the wording and saves via a checked write. Printing is locked in
   ro-invoice.test.js.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  WARRANTY_PRESETS, VENDOR_WARNING, MAX_WARRANTY_LEN,
  presetById, insertPreset, hasVendorWarranty, warrantyForSave,
} from './warranty-presets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BOARD = readFileSync(join(root, 'advisor-board.html'), 'utf8');

// Cris-approved wording, 2026-09-19 — copied from the build request verbatim.
const APPROVED = [
  'Transmission Rebuild — 1 year or 12,000 miles parts & labor warranty, whichever comes first.',
  "Remanufactured Transmission — 3 years or 100,000 miles parts & labor warranty, whichever comes first, provided by the unit's manufacturer.",
  "Remanufactured Transmission — 3 years / unlimited miles parts & labor warranty, provided by the unit's manufacturer.",
  'Customer-provided parts — no warranty can be given on this repair.',
  'Customer declined the recommended repair — no warranty can be given on the work performed.',
  'Comeback — the original warranty still stands.',
];

// ── the list ────────────────────────────────────────────────
test('the six presets are the approved wording, exactly, in order', () => {
  assert.deepEqual(WARRANTY_PRESETS.map((p) => p.text), APPROVED);
});

test('the vendor flag is on presets 2 and 3 ONLY (manufacturer warranties)', () => {
  assert.deepEqual(WARRANTY_PRESETS.map((p) => p.vendor), [false, true, true, false, false, false]);
});

test('Kevin\'s "1 Year parts & labor" is deliberately NOT a preset', () => {
  assert.equal(WARRANTY_PRESETS.some((p) => /^1 year parts/i.test(p.text)), false);
});

test('presets are frozen, ids unique, every one has a short label; presetById finds them', () => {
  assert.ok(Object.isFrozen(WARRANTY_PRESETS));
  WARRANTY_PRESETS.forEach((p) => assert.ok(Object.isFrozen(p)));
  const ids = WARRANTY_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  WARRANTY_PRESETS.forEach((p) => { assert.ok(p.label && p.label.length < 50, p.id); assert.equal(presetById(p.id), p); });
  assert.equal(presetById('nope'), null);
  assert.equal(presetById(''), null);
});

test('the vendor warning text is the approved on-screen wording', () => {
  assert.equal(VENDOR_WARNING, "⚠ Vendor warranty — confirm this supplier's exact terms before putting it on the invoice.");
});

// ── insert vs append ────────────────────────────────────────
test('insertPreset: an EMPTY box gets the preset', () => {
  for (const empty of ['', '   ', '\n\n', null, undefined]) assert.equal(insertPreset(empty, APPROVED[0]), APPROVED[0]);
});

test('insertPreset: a box WITH text keeps it and gets the preset on a NEW line', () => {
  assert.equal(insertPreset('1 year parts & labor on the starter.', APPROVED[1]),
    '1 year parts & labor on the starter.\n' + APPROVED[1]);
  // trailing blank lines / spaces don't leave a gap
  assert.equal(insertPreset('custom text  \n\n', APPROVED[0]), 'custom text\n' + APPROVED[0]);
  // two presets → two lines, in pick order
  assert.equal(insertPreset(insertPreset('', APPROVED[0]), APPROVED[3]), APPROVED[0] + '\n' + APPROVED[3]);
  // existing multi-line text is untouched
  assert.equal(insertPreset('a\nb', 'c'), 'a\nb\nc');
});

test('insertPreset: a blank preset changes nothing', () => {
  assert.equal(insertPreset('keep me', ''), 'keep me');
});

// ── vendor warning trigger ──────────────────────────────────
test('hasVendorWarranty: on while the box contains preset 2 or 3; off otherwise', () => {
  assert.equal(hasVendorWarranty(APPROVED[1]), true);
  assert.equal(hasVendorWarranty('intro\n' + APPROVED[2]), true);
  assert.equal(hasVendorWarranty(APPROVED[0] + '\n' + APPROVED[3]), false);
  assert.equal(hasVendorWarranty('3 year reman warranty'), false, 'custom wording is not flagged');
  assert.equal(hasVendorWarranty(''), false);
  assert.equal(hasVendorWarranty(null), false);
});

// ── what is saved ───────────────────────────────────────────
test('warrantyForSave: the FULL text is saved (line breaks kept); blank → NULL', () => {
  assert.deepEqual(warrantyForSave(''), { ok: true, value: null });
  assert.deepEqual(warrantyForSave('  \n '), { ok: true, value: null });
  assert.deepEqual(warrantyForSave(null), { ok: true, value: null });
  assert.deepEqual(warrantyForSave('  ' + APPROVED[0] + '\ncustom line  '), { ok: true, value: APPROVED[0] + '\ncustom line' });
  assert.deepEqual(warrantyForSave('a\r\nb\rc'), { ok: true, value: 'a\nb\nc' }, 'Windows line endings normalised');
});

test('warrantyForSave: over the cap is refused (the DB CHECK would reject it)', () => {
  assert.equal(warrantyForSave('x'.repeat(MAX_WARRANTY_LEN)).ok, true);
  const r = warrantyForSave('x'.repeat(MAX_WARRANTY_LEN + 1));
  assert.equal(r.ok, false); assert.equal(r.reason, 'too-long'); assert.equal(r.max, MAX_WARRANTY_LEN);
});

// ── migrations agree ────────────────────────────────────────
test('both migrations: nullable text column, CHECK = the same length cap, guarded, undo present', () => {
  const files = readdirSync(join(root, 'migrations')).filter((f) => /_ro_warranty_terms_(SANDBOX|PROD)\.sql$/.test(f));
  assert.deepEqual(files.map((f) => f.match(/_(SANDBOX|PROD)\.sql$/)[1]).sort(), ['PROD', 'SANDBOX']);
  for (const f of files) {
    const sql = readFileSync(join(root, 'migrations', f), 'utf8');
    assert.match(sql, /add column if not exists warranty_terms text;/, f);
    const cap = sql.match(/check \(warranty_terms is null or char_length\(warranty_terms\) <= (\d+)\)/);
    assert.ok(cap, f + ': CHECK');
    assert.equal(Number(cap[1]), MAX_WARRANTY_LEN, f + ': cap matches the app');
    assert.match(sql, /drop column if exists warranty_terms/, f + ': undo');
    if (f.includes('SANDBOX')) assert.match(sql, /if v like 'PROD%' then/);
    else assert.match(sql, /if v not like 'PROD%' then/);
    const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    assert.doesNotMatch(code, /\bupdate\s+public\.repair_orders\s+set/i, f + ': no backfill');
  }
});

// ── the advisor board ───────────────────────────────────────
test('board: the box is labelled as Cris asked, sits under Advisory Notes, and has a NEW badge', () => {
  const adv = BOARD.indexOf('id="cdRoAdvisory"');
  const box = BOARD.indexOf('id="cdRoWarrantyTerms"');
  assert.ok(adv > 0 && box > adv, 'after Advisory Notes');
  assert.match(BOARD, /<label for="cdRoWarrantyTerms">Warranty given — prints on the estimate &amp; invoice<span class="cd-new" data-new-until="\d{4}-\d{2}-\d{2}">NEW<\/span><\/label>/);
  assert.match(BOARD, /<option value="">Insert preset…<\/option>/);
});

test('board: no inline copy of the preset wording; loads shared/warranty-presets.js', () => {
  for (const t of APPROVED) assert.equal(BOARD.includes(t), false, 'inline copy: ' + t.slice(0, 30));
  assert.equal(BOARD.includes('Vendor warranty — confirm'), false, 'warning text lives in the shared file');
  assert.match(BOARD, /import \* as WarrantyPresets from '\.\/shared\/warranty-presets\.js';/);
});

test('board: a pick inserts via insertPreset and saves; the save is a CHECKED write of the full text', () => {
  const pick = BOARD.slice(BOARD.indexOf('function onWarrantyPresetPick('), BOARD.indexOf('function onWarrantyPresetPick(') + 900);
  assert.match(pick, /box\.value = WP\.insertPreset\(box\.value, p\.text\);/);
  assert.match(pick, /queueWarrantySave\(\);/);
  const save = BOARD.slice(BOARD.indexOf('function queueWarrantySave('), BOARD.indexOf('function onWarrantyPresetPick('));
  assert.match(save, /WP\.warrantyForSave\(box\.value\)/);
  assert.match(save, /\.update\(\{ warranty_terms: r\.value \}\)\.eq\('id', ro\.id\)\.select\('id, warranty_terms'\)/);
  assert.match(save, /if \(error \|\| !data \|\| !data\.length\)/, 'a 0-row write is a failure');
  assert.doesNotMatch(save, /updateRoField\(/, 'not the error-swallowing generic save');
});
