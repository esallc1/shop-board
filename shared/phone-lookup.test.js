/* ============================================================
   phone-lookup.test.js — unit tests for the customer phone lookup.
   Run: npm test   (node --test)

   These lock the things that caused, or could re-cause, the 1,000-row bug:
     • the pattern matches EVERY phone shape stored in the table, so the
       server-side filter can't quietly miss rows the old client-side scan
       would have seen;
     • the pattern is END-anchored — "last 10 digits" means last;
     • the pattern only NARROWS; matchesLast10 is the authority, so an
       over-broad pattern can never produce a wrong match;
     • nothing here names phone_primary_l10 / phone_secondary_l10 — those
       columns do not exist on prod.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  last10, ilikePatternFor, phoneOrFilter, matchesLast10, confirmPhoneMatches,
} from './phone-lookup.js';

// The three shapes that actually live in the customers table today.
const STORED_SHAPES = ['8135909459', '(813) 590-9459', '813-590-9459'];
const JOSE = { id: 'jose', name: 'JOSE RAMIREZ', phone_primary: '8135909459', phone_secondary: null };

// A JS stand-in for what PostgREST's ilike does with a `*` pattern.
const ilike = (value, pattern) => {
  const rx = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return rx.test(String(value == null ? '' : value));
};

test('last10 strips punctuation and keeps the last ten digits', () => {
  assert.equal(last10('(786) 531-5419'), '7865315419');
  assert.equal(last10('+1 813-590-9459'), '8135909459');
  assert.equal(last10('8135909459'), '8135909459');
  assert.equal(last10(null), '');
});

// ── the pattern ──────────────────────────────────────────────
test('ilikePatternFor splits a 10-digit key 3-3-4 and anchors the END', () => {
  assert.equal(ilikePatternFor('8135909459'), '*813*590*9459');
  assert.ok(!ilikePatternFor('8135909459').endsWith('*'), 'no trailing wildcard — "last 10" means last');
});

test('THE BUG THIS FIXES: the pattern matches every phone shape in the table', () => {
  // "8135909459" (2750 rows), "(813) 590-9459" (32), "813-590-9459" (1).
  // A plain equality filter would find only the first — which is why the old
  // code scanned client-side, which is what hit the 1,000-row cap.
  const pat = ilikePatternFor('8135909459');
  for (const stored of STORED_SHAPES) {
    assert.ok(ilike(stored, pat), `pattern must match ${stored}`);
  }
  assert.ok(ilike('+1 (813) 590-9459', pat), 'and a country-code form');
  assert.ok(ilike('813.590.9459', pat), 'and dots');
});

test('the pattern does NOT match a different number that merely shares digits', () => {
  const pat = ilikePatternFor('8135909459');
  assert.equal(ilike('8135909450', pat), false);
  assert.equal(ilike('9135909459', pat), false);
  assert.equal(ilike('81359094590', pat), false, 'end-anchored: a longer number must not match');
});

test('a short key is used whole (and still finds nothing after the exact re-check)', () => {
  assert.equal(ilikePatternFor('5551234'), '*5551234');
  assert.equal(matchesLast10({ phone_primary: '2395551234' }, '5551234'), false,
    'a 7-digit key can never equal a 10-digit last-10 — same as before the fix');
});

test('ilikePatternFor returns null when there is nothing to search for', () => {
  assert.equal(ilikePatternFor(''), null);
  assert.equal(ilikePatternFor(null), null);
  assert.equal(ilikePatternFor('---'), null);
});

// ── the or() filter ──────────────────────────────────────────
test('phoneOrFilter covers BOTH phone columns and names no generated column', () => {
  const f = phoneOrFilter('8135909459');
  assert.equal(f, 'phone_primary.ilike.*813*590*9459,phone_secondary.ilike.*813*590*9459');
  // phone_primary_l10 / phone_secondary_l10 exist on the SANDBOX ONLY. If this
  // filter ever names them, the lookup returns nothing for everyone on prod.
  assert.ok(!/_l10/.test(f), 'must not depend on the sandbox-only generated columns');
  assert.equal(phoneOrFilter(''), null);
});

// ── the authority ────────────────────────────────────────────
test('matchesLast10 is the authority — it re-checks what the server returned', () => {
  assert.equal(matchesLast10(JOSE, '8135909459'), true);
  assert.equal(matchesLast10(JOSE, '(813) 590-9459'), true);
  assert.equal(matchesLast10(JOSE, '18135909459'), true, 'country code trimmed by last10');
  assert.equal(matchesLast10(JOSE, '8135909450'), false);
  assert.equal(matchesLast10({ phone_secondary: '8135909459' }, '8135909459'), true, 'secondary counts');
  assert.equal(matchesLast10(null, '8135909459'), false);
  assert.equal(matchesLast10(JOSE, '12345'), false, 'a non-10-digit key never matches');
});

test('an over-broad server pattern can never produce a wrong match', () => {
  // Simulate the server handing back a row the pattern caught but that is not
  // actually this number. confirmPhoneMatches must drop it.
  const rows = [JOSE, { id: 'other', phone_primary: '8135909999' }];
  assert.deepEqual(confirmPhoneMatches(rows, '8135909459').map(c => c.id), ['jose']);
});

test('confirmPhoneMatches de-dupes — the two or() branches can return one row twice', () => {
  const rows = [JOSE, JOSE, { ...JOSE }];
  assert.equal(confirmPhoneMatches(rows, '8135909459').length, 1);
});

test('confirmPhoneMatches copes with junk and preserves order', () => {
  const a = { id: 'a', phone_primary: '8135909459' };
  const b = { id: 'b', phone_secondary: '813-590-9459' };
  assert.deepEqual(confirmPhoneMatches([null, a, undefined, { id: null }, b], '8135909459').map(c => c.id), ['a', 'b']);
  assert.deepEqual(confirmPhoneMatches([], '8135909459'), []);
  assert.deepEqual(confirmPhoneMatches(null, '8135909459'), []);
});

test('a real two-customer collision still returns BOTH (the pick list case)', () => {
  const rows = [{ id: 'a', phone_primary: '8135909459' }, { id: 'b', phone_primary: '(813) 590-9459' }];
  assert.equal(confirmPhoneMatches(rows, '8135909459').length, 2);
});
