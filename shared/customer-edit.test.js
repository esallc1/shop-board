/* ============================================================
   customer-edit.test.js — the customer Edit form's patch + duplicate-phone
   check. Run: npm test   (node --test)

   Locks:
     • last-10 normalisation: every stored phone shape, and a +1 country code,
       match the same number;
     • the customer being edited is never its own conflict;
     • an ARCHIVED (merged-away) customer is never a conflict;
     • only a NEW or CHANGED number is checked — an already-shared number or a
       primary/secondary swap does not warn;
     • the patch writes only the form's columns, blanks become NULL, and only
       the name is required.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDIT_FIELDS, buildCustomerPatch, newPhoneKeys, conflictOrFilter, findPhoneConflicts,
} from './customer-edit.js';

const SELF  = { id: 'self',  name: 'Ana Cruz',   phone_primary: '2395550100', phone_secondary: null };
const OTHER = { id: 'other', name: 'Dave Allen', phone_primary: '(239) 265-4987', phone_secondary: null };
const SEC   = { id: 'sec',   name: 'Mint Motors', phone_primary: null, phone_secondary: '239-265-4987' };
const GONE  = { id: 'gone',  name: 'Allen Dave', phone_primary: '2392654987', phone_secondary: null,
                archived_at: '2026-08-19T00:00:00Z', merged_into: 'other' };

// ── findPhoneConflicts ───────────────────────────────────────
test('last-10: every stored shape and a +1 prefix all match the same key', () => {
  for (const key of ['2392654987', '(239) 265-4987', '239-265-4987', '+1 239 265 4987', '12392654987']) {
    const hits = findPhoneConflicts([OTHER], { selfId: 'self', keys: [key] });
    assert.equal(hits.length, 1, 'no match for ' + key);
    assert.equal(hits[0].customer.id, 'other');
  }
});

test('matches the OTHER customer on either phone field', () => {
  const hits = findPhoneConflicts([OTHER, SEC], { selfId: 'self', keys: ['2392654987'] });
  assert.deepEqual(hits.map((h) => h.customer.id), ['other', 'sec']);
  assert.deepEqual(hits[0].keys, ['2392654987']);
});

test('excludes SELF — the customer being edited is never its own conflict', () => {
  const selfWithNumber = { ...SELF, phone_secondary: '2392654987' };
  const hits = findPhoneConflicts([selfWithNumber, OTHER], { selfId: 'self', keys: ['2392654987'] });
  assert.deepEqual(hits.map((h) => h.customer.id), ['other']);
  // id compared as a string — a numeric id from elsewhere still excludes self
  const n = findPhoneConflicts([{ id: 7, name: 'x', phone_primary: '2392654987' }], { selfId: '7', keys: ['2392654987'] });
  assert.deepEqual(n, []);
});

test('excludes ARCHIVED (merged-away) customers', () => {
  const hits = findPhoneConflicts([GONE, OTHER], { selfId: 'self', keys: ['2392654987'] });
  assert.deepEqual(hits.map((h) => h.customer.id), ['other']);
  assert.deepEqual(findPhoneConflicts([GONE], { selfId: 'self', keys: ['2392654987'] }), []);
});

test('the server pattern only narrows — a near-miss row is re-checked out', () => {
  const near = { id: 'near', name: 'Near', phone_primary: '2392654988' };
  const longer = { id: 'long', name: 'Long', phone_primary: '23926549870' };   // last-10 differs
  assert.deepEqual(findPhoneConflicts([near, longer], { selfId: 'self', keys: ['2392654987'] }), []);
});

test('de-dupes a row returned twice (the two ilike branches of the or)', () => {
  const hits = findPhoneConflicts([OTHER, OTHER], { selfId: 'self', keys: ['2392654987'] });
  assert.equal(hits.length, 1);
});

test('no usable keys → no conflicts, even against matching rows', () => {
  assert.deepEqual(findPhoneConflicts([OTHER], { selfId: 'self', keys: [] }), []);
  assert.deepEqual(findPhoneConflicts([OTHER], { selfId: 'self', keys: ['4987'] }), []);
  assert.deepEqual(findPhoneConflicts(null, { selfId: 'self', keys: ['2392654987'] }), []);
});

test('reports which of several keys each customer matched', () => {
  const both = { id: 'both', name: 'Both', phone_primary: '2392654987', phone_secondary: '8135909459' };
  const hits = findPhoneConflicts([both], { selfId: 'self', keys: ['2392654987', '8135909459'] });
  assert.deepEqual(hits[0].keys, ['2392654987', '8135909459']);
});

// ── newPhoneKeys ─────────────────────────────────────────────
test('newPhoneKeys: a changed number is checked, an unchanged one is not', () => {
  const before = { phone_primary: '2395550100', phone_secondary: null };
  assert.deepEqual(newPhoneKeys(before, { phone_primary: '(239) 555-0100', phone_secondary: '239-265-4987' }),
    ['2392654987']);
  assert.deepEqual(newPhoneKeys(before, { phone_primary: '239.555.0100', phone_secondary: null }), []);
});

test('newPhoneKeys: swapping primary and secondary is not a new number', () => {
  const before = { phone_primary: '2395550100', phone_secondary: '2392654987' };
  assert.deepEqual(newPhoneKeys(before, { phone_primary: '2392654987', phone_secondary: '2395550100' }), []);
});

test('newPhoneKeys: blanks and short numbers are never keys; duplicates collapse', () => {
  assert.deepEqual(newPhoneKeys({}, { phone_primary: null, phone_secondary: '555-0100' }), []);
  assert.deepEqual(newPhoneKeys({}, { phone_primary: '2392654987', phone_secondary: '(239) 265-4987' }), ['2392654987']);
  assert.deepEqual(newPhoneKeys(null, { phone_primary: '+1 239 265 4987' }), ['2392654987']);
});

test('conflictOrFilter covers both columns for every key, null when empty', () => {
  assert.equal(conflictOrFilter([]), null);
  assert.equal(conflictOrFilter(['2392654987']),
    'phone_primary.ilike.*239*265*4987,phone_secondary.ilike.*239*265*4987');
  assert.equal(conflictOrFilter(['2392654987', '8135909459']).split(',').length, 4);
});

// ── buildCustomerPatch ───────────────────────────────────────
test('buildCustomerPatch: only name is required; blank primary phone is allowed', () => {
  assert.equal(buildCustomerPatch({ name: '   ' }).error, 'Name is required.');
  const { patch, error } = buildCustomerPatch({ name: ' Ana ', phone_primary: '  ' });
  assert.equal(error, null);
  assert.equal(patch.name, 'Ana');
  assert.equal(patch.phone_primary, null);
});

test('buildCustomerPatch: writes exactly the form columns, blanks → null', () => {
  const { patch } = buildCustomerPatch({
    name: 'Ana', email: ' a@b.co ', city: '', tax_exempt: true, country: 'CA', phone_primary_l10: 'x',
  });
  assert.deepEqual(Object.keys(patch).sort(), [...EDIT_FIELDS].sort());
  assert.equal(patch.email, 'a@b.co');
  assert.equal(patch.city, null);
  assert.ok(!('tax_exempt' in patch) && !('country' in patch) && !('phone_primary_l10' in patch));
});
