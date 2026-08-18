/* ============================================================
   customer-archive.test.js — unit tests for post-merge visibility.
   Run: npm test   (node --test)

   These lock the two halves of "archiving means something":
     • a SEARCH or MATCH must never return an archived customer — otherwise the
       merge changed nothing the crew can see;
     • a row loaded BY ID must still render, with a pointer to the survivor.
   And the migration-safety property: on a project without the columns, every
   helper behaves exactly as the app did before the merge feature existed.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVED_COL, MERGE_COLS, isArchived, filterActive, mergedIntoId,
  shouldShowMergedBanner, mergedBannerText,
} from './customer-archive.js';

const KEEPER  = { id: 'keep', name: 'IAN GEQUELIN', archived_at: null, merged_into: null };
const LOSER   = { id: 'lose', name: 'ian gequelin', archived_at: '2026-08-19T00:00:00Z', merged_into: 'keep' };
// A row from a project where the hand-run migration has NOT been applied.
const PRE_MIGRATION = { id: 'old', name: 'KEVIN CRUZ' };

test('isArchived is true only for a row with archived_at set', () => {
  assert.equal(isArchived(LOSER), true);
  assert.equal(isArchived(KEEPER), false);
  assert.equal(isArchived(PRE_MIGRATION), false, 'no column → not archived');
  assert.equal(isArchived({ archived_at: undefined }), false);
  assert.equal(isArchived(null), false);
});

test('THE POINT OF THE WHOLE FEATURE: a search never returns the archived row', () => {
  assert.deepEqual(filterActive([KEEPER, LOSER]).map(c => c.id), ['keep']);
});

test('filterActive preserves order, never mutates, and copes with junk', () => {
  const rows = [LOSER, KEEPER, null, undefined, { id: 'x' }];
  const before = rows.length;
  assert.deepEqual(filterActive(rows).map(c => c.id), ['keep', 'x']);
  assert.equal(rows.length, before, 'input untouched');
  assert.deepEqual(filterActive([]), []);
  assert.deepEqual(filterActive(null), []);
});

test('MIGRATION SAFETY: on a project without the columns, nothing is dropped', () => {
  // This is the fallback path — the server-side filter 42703s, we retry
  // unfiltered, and filterActive must then behave as it did before the feature.
  const rows = [PRE_MIGRATION, { id: 'b', name: 'kevin cruz' }];
  assert.deepEqual(filterActive(rows).map(c => c.id), ['old', 'b']);
});

test('mergedIntoId points at the survivor, or null', () => {
  assert.equal(mergedIntoId(LOSER), 'keep');
  assert.equal(mergedIntoId(KEEPER), null);
  assert.equal(mergedIntoId(PRE_MIGRATION), null);
  assert.equal(mergedIntoId({ merged_into: '' }), null);
  assert.equal(mergedIntoId(null), null);
  assert.equal(mergedIntoId({ merged_into: 7 }), '7', 'coerced to string for a DOM lookup');
});

test('the banner shows only when we can actually point somewhere', () => {
  assert.equal(shouldShowMergedBanner(LOSER), true);
  assert.equal(shouldShowMergedBanner(KEEPER), false, 'a live record gets no banner');
  // Archived but never merged — a future "archive this customer" action. No
  // keeper to point at, so no pointer.
  assert.equal(shouldShowMergedBanner({ archived_at: '2026-08-19T00:00:00Z', merged_into: null }), false);
  assert.equal(shouldShowMergedBanner(PRE_MIGRATION), false);
});

test('the banner names the survivor, and degrades if it could not be loaded', () => {
  assert.match(mergedBannerText('IAN GEQUELIN'), /merged into IAN GEQUELIN/);
  assert.match(mergedBannerText(null), /merged into another customer/);
  assert.match(mergedBannerText('   '), /merged into another customer/);
  assert.match(mergedBannerText('IAN GEQUELIN'), /vehicles, repair orders and calls now live there/);
});

test('the column names are exported once so a call site cannot typo them', () => {
  assert.equal(ARCHIVED_COL, 'archived_at');
  assert.equal(MERGE_COLS, 'archived_at, merged_into');
});
