/* ============================================================
   job-category.test.js — THE job-category list, and the close copy.
   Run: npm test   (node --test)

   Locks:
   1. The list is exactly the two values Cris chose, in order, and blank = NULL.
   2. Both migration files' CHECK allows exactly that list (the DB and the app
      can't drift — the list lives in ONE file, the SQL is checked against it).
   3. The close copy: the RO's category reaches the completed_jobs payload, a
      blank one stays NULL — and the board's archive really uses it, reads the
      RO (not the floor), and nothing on the board writes job_category to the
      floor tables (static guard, same approach as cust-cache-guard.test.js).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  JOB_CATEGORIES, UNSET_LABEL, normalizeJobCategory, isJobCategoryUnset,
  buildJobCategoryOptions, jobCategoryForSave, archiveJobCategory,
} from './job-category.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BOARD = readFileSync(join(root, 'advisor-board.html'), 'utf8');

// ── 1. the list ─────────────────────────────────────────────
test('JOB_CATEGORIES is exactly the two chosen values, in order, and frozen', () => {
  assert.deepEqual([...JOB_CATEGORIES], ['Transmission rebuild', 'General repair']);
  assert.ok(Object.isFrozen(JOB_CATEGORIES));
  assert.equal(UNSET_LABEL, 'Pick a category');
});

test('normalizeJobCategory: exact list values only; blank/unknown/old names → null', () => {
  assert.equal(normalizeJobCategory('Transmission rebuild'), 'Transmission rebuild');
  assert.equal(normalizeJobCategory('  General repair '), 'General repair');
  for (const v of [null, undefined, '', '   ', 'transmission rebuild', 'GENERAL REPAIR',
                   'Rebuild', 'Gen Auto', 'Diag', 'Other']) {
    assert.equal(normalizeJobCategory(v), null, JSON.stringify(v));
  }
});

test('isJobCategoryUnset: only null/blank is unset (drives the red outline)', () => {
  assert.equal(isJobCategoryUnset(null), true);
  assert.equal(isJobCategoryUnset(undefined), true);
  assert.equal(isJobCategoryUnset(''), true);
  assert.equal(isJobCategoryUnset('  '), true);
  assert.equal(isJobCategoryUnset('Transmission rebuild'), false);
  assert.equal(isJobCategoryUnset('General repair'), false);
});

test('buildJobCategoryOptions: "Pick a category" first, then the list; current selected', () => {
  const blank = buildJobCategoryOptions(null);
  assert.deepEqual(blank.map((o) => o.value), ['', 'Transmission rebuild', 'General repair']);
  assert.equal(blank[0].label, 'Pick a category');
  assert.deepEqual(blank.filter((o) => o.selected).map((o) => o.value), ['']);

  const set = buildJobCategoryOptions('General repair');
  assert.deepEqual(set.filter((o) => o.selected).map((o) => o.value), ['General repair']);
  assert.equal(set.length, 3);
});

test('buildJobCategoryOptions: an off-list stored value is shown (appended + selected), never hidden', () => {
  const opts = buildJobCategoryOptions('Rebuild');
  assert.equal(opts.length, 4);
  assert.deepEqual(opts[3], { value: 'Rebuild', label: 'Rebuild', selected: true });
  assert.equal(opts.filter((o) => o.selected).length, 1);
});

test('jobCategoryForSave: "Pick a category" saves NULL; a list value saves as-is; junk never reaches the CHECK', () => {
  assert.equal(jobCategoryForSave(''), null);
  assert.equal(jobCategoryForSave('Transmission rebuild'), 'Transmission rebuild');
  assert.equal(jobCategoryForSave('General repair'), 'General repair');
  assert.equal(jobCategoryForSave('Gen Auto'), null);
});

// ── 2. the migrations agree with the list ───────────────────
test('both migration files CHECK exactly JOB_CATEGORIES (or NULL) and carry an undo', () => {
  const files = readdirSync(join(root, 'migrations')).filter((f) => /_ro_job_category_(SANDBOX|PROD)\.sql$/.test(f));
  assert.deepEqual(files.map((f) => f.match(/_(SANDBOX|PROD)\.sql$/)[1]).sort(), ['PROD', 'SANDBOX']);
  for (const f of files) {
    const sql = readFileSync(join(root, 'migrations', f), 'utf8');
    const m = sql.match(/check\s*\(\s*job_category is null or job_category in \(([^)]*)\)\s*\)/i);
    assert.ok(m, f + ': CHECK not found');
    const vals = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(vals, [...JOB_CATEGORIES], f);
    assert.match(sql, /add column if not exists job_category text;/, f + ': nullable text, no default');
    assert.match(sql, /drop column if exists job_category/, f + ': undo');
    const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');   // executable SQL only
    assert.doesNotMatch(code, /\b(insert\s+into|update|alter\s+table|delete\s+from)\s+(public\.)?shopboard_/i, f + ': must not touch the floor tables');
    assert.doesNotMatch(code, /\b(insert\s+into|update|alter\s+table|delete\s+from)\s+(public\.)?completed_jobs\b/i, f + ': no backfill / no archive change');
    // guard direction: SANDBOX refuses PROD, PROD refuses anything else
    if (f.includes('SANDBOX')) assert.match(sql, /if v like 'PROD%' then/);
    else assert.match(sql, /if v not like 'PROD%' then/);
  }
});

// ── 3. the close copy ───────────────────────────────────────
test('archiveJobCategory: the RO\'s category reaches completed_jobs; blank stays NULL', () => {
  assert.equal(archiveJobCategory({ id: 'r1', job_category: 'Transmission rebuild' }), 'Transmission rebuild');
  assert.equal(archiveJobCategory({ id: 'r2', job_category: 'General repair' }), 'General repair');
  assert.equal(archiveJobCategory({ id: 'r3', job_category: null }), null);
  assert.equal(archiveJobCategory({ id: 'r4', job_category: '' }), null);
  assert.equal(archiveJobCategory({ id: 'r5' }), null);              // pre-migration row: no column
  assert.equal(archiveJobCategory(null), null);
});

// Body of a named function in the board: from its declaration to the next
// top-level (4-space) function declaration.
function fnBody(name) {
  const start = BOARD.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in advisor-board.html');
  const rest = BOARD.slice(start + 10);
  const next = rest.search(/\n    (async )?function /);
  return BOARD.slice(start, start + 10 + (next < 0 ? rest.length : next));
}

test('board: archiveToCompletedJobs puts the RO\'s category (via archiveJobCategory) into the payload', () => {
  const body = fnBody('archiveToCompletedJobs');
  assert.match(body, /job_category:\s*window\.JobCategory\s*\?\s*window\.JobCategory\.archiveJobCategory\(ro\)/);
  // `ro` there is currentRo — the repair_orders row — not a floor row.
  assert.match(body, /const ro = currentRo\b/);
  assert.doesNotMatch(body, /shopboard_/);
});

test('board: the Off-lot path re-reads the RO before closing (so the archive sees its category)', () => {
  const offLot = fnBody('offLotCard');
  assert.ok(offLot.indexOf('removeCarFromFloor') < offLot.indexOf('loadRoContext'), 'floor first, then RO re-read');
  assert.match(fnBody('loadRoContext'), /\.from\('repair_orders'\)\s*\n?\s*\.select\('\*, /);
});

test('board: job_category is never WRITTEN to a floor table by the advisor board', () => {
  // Every floor write in the board (insert/update into shopboard_*) — none may
  // carry a category. EMPTY_LIFT's pre-existing `job_category: ''` clears a lift
  // on Off-lot (v1 row shape) and is the one allowed mention.
  const lines = BOARD.split('\n');
  lines.forEach((line, i) => {
    if (!/\.from\('shopboard_(lifts|parking|pickup)'\)/.test(line)) return;
    const win = lines.slice(i, i + 4).join(' ');
    if (!/\.(insert|update|upsert)\(/.test(win)) return;
    assert.doesNotMatch(win, /job_category\s*:\s*(?!'')/, 'line ' + (i + 1));
  });
  const setter = fnBody('setJobCategory');
  assert.match(setter, /\.from\('repair_orders'\)/);
  assert.doesNotMatch(setter, /shopboard_/);
});

test('board: the list is not copied inline — the two values appear only via shared/job-category.js', () => {
  assert.doesNotMatch(BOARD, /'Transmission rebuild'|"Transmission rebuild"|'General repair'|"General repair"/);
  assert.match(BOARD, /import \* as JobCategory from '\.\/shared\/job-category\.js';/);
});
