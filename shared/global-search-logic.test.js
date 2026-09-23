/* ============================================================
   global-search-logic.test.js — the advisor board's top-bar search.
   Run: npm test   (node --test)

   Locks: what a query is (phone / RO / VIN / plate / note words), which group
   leads, how customers rank (the old Customers-tab rule), the PostgREST filters
   (every note word must match; nothing typed can break the or=(…) syntax), the
   "RO #6012 · PO 5473" label, where each result opens (an unattached call NEVER
   opens a guessed customer), arrow-key selection, the "/" rule — and, statically,
   one "+ New RO" button, the bar mounted once, the Customers tab's own search box
   gone with the A–Z browse kept.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyQuery, groupOrder, searchCustomerList, vehicleOr, roOr, callOrs, safeWords,
  noteSnippet, roLabel, destination, flattenGroups, moveSelection, PER_GROUP,
} from './global-search-logic.js';
import { isTypingTarget } from './desk-pad-logic.js';

const here = dirname(fileURLToPath(import.meta.url));
const board = readFileSync(join(here, '..', 'advisor-board.html'), 'utf8');
const ui = readFileSync(join(here, 'global-search.js'), 'utf8');

test('classify: a name, a phone, an RO / PO number, a VIN, a plate, note words', () => {
  const name = classifyQuery('maria');
  assert.equal(name.lead, 'customer'); assert.equal(name.calls, true); assert.equal(name.ros, false);
  const phone = classifyQuery('(239) 555-0142');
  assert.equal(phone.lead, 'customer'); assert.equal(phone.digits, '2395550142'); assert.equal(phone.ros, false);
  for (const q of ['6012', '#6012', '5473']) {
    const c = classifyQuery(q);
    assert.equal(c.lead, 'ro', q); assert.equal(c.ros, true, q); assert.equal(c.calls, false, q);
  }
  const vin = classifyQuery('1FT7W2BT5EEB10442');
  assert.equal(vin.vinLike, true); assert.equal(vin.lead, 'vehicle');
  const plate = classifyQuery('KXR 4471');
  assert.equal(plate.vehicles, true); assert.equal(plate.compact, 'KXR4471');
  const note = classifyQuery('starter bolts');
  assert.deepEqual(note.words, ['starter', 'bolts']); assert.equal(note.calls, true);
  const tiny = classifyQuery('a');
  assert.equal(tiny.customers || tiny.vehicles || tiny.ros || tiny.calls, false);
  assert.doesNotThrow(() => classifyQuery(null));
});

test('group order: the likely kind first, then Customers / Vehicles / ROs / Call notes', () => {
  assert.deepEqual(groupOrder(classifyQuery('maria')), ['customer', 'vehicle', 'ro', 'call']);
  assert.deepEqual(groupOrder(classifyQuery('6012')), ['ro', 'customer', 'vehicle', 'call']);
  assert.deepEqual(groupOrder(classifyQuery('1FT7W2BT5EEB10442')), ['vehicle', 'customer', 'ro', 'call']);
  assert.deepEqual(groupOrder(null), ['customer', 'vehicle', 'ro', 'call']);
});

test('customers: the Customers-tab match rule, ranked; merged / archived dropped', () => {
  const list = [
    { id: 1, name: 'Maria Lopez', phone_primary: '(239) 555-0142' },
    { id: 2, name: 'Ana Maria Ruiz', phone_primary: '239-555-9999' },
    { id: 3, name: 'Rosemarian Diaz' },
    { id: 4, name: 'Maria Old', archived_at: '2026-09-01', merged_into: 1 },
    { id: 5, name: 'Bob', business_name: 'JDPR Construction', phone_secondary: '+1 239 745 2132' },
  ];
  assert.deepEqual(searchCustomerList(list, classifyQuery('maria')).map((c) => c.id), [2, 1, 3]);   // word-start, A–Z, then contains
  assert.deepEqual(searchCustomerList(list, classifyQuery('2395550142')).map((c) => c.id), [1]);   // exact phone
  assert.deepEqual(searchCustomerList(list, classifyQuery('555')).map((c) => c.id), [2, 1]);       // partial phone (tie → A–Z)
  assert.deepEqual(searchCustomerList(list, classifyQuery('jdpr')).map((c) => c.id), [5]);         // business name
  assert.deepEqual(searchCustomerList(list, classifyQuery('7452132')).map((c) => c.id), [5]);      // second phone
  assert.ok(!searchCustomerList(list, classifyQuery('maria old')).some((c) => c.id === 4), 'merged customer shown');
});

test('filters: RO number OR old PO; plate/VIN loose; every note word must appear', () => {
  assert.equal(roOr(classifyQuery('6012')), 'ro_number.eq.6012,po.ilike.6012*');
  assert.equal(roOr(classifyQuery('maria')), null);
  assert.match(vehicleOr(classifyQuery('KXR 4471')), /plate\.ilike\.\*KXR\*4471\*/);
  assert.match(vehicleOr(classifyQuery('KXR 4471')), /vin\.ilike\.\*KXR4471\*/);
  assert.deepEqual(callOrs(classifyQuery('Starter bolts')), [
    'note.ilike.*starter*,outcome_note.ilike.*starter*',
    'note.ilike.*bolts*,outcome_note.ilike.*bolts*',
  ]);
});

test('nothing typed can break the filter syntax or add a wildcard', () => {
  const nasty = 'bolts, (f250) *x* "q" a.b\\c:d';
  for (const f of callOrs(classifyQuery(nasty))) {
    const inner = f.replace(/note\.ilike\.\*|outcome_note\.ilike\.\*/g, '').replace(/\*,|\*$/g, '');
    assert.doesNotMatch(inner, /[,()*"\\.:]/, f);
  }
  assert.deepEqual(safeWords('  O\'Reilly #6012 -- ok  '), ["o'reilly", '6012', 'ok']);
});

test('labels: RO shows both numbers when they differ; note snippet keeps the matched word', () => {
  assert.equal(roLabel({ ro_number: 6012, po: '5473' }), 'RO #6012 · PO 5473');
  assert.equal(roLabel({ ro_number: 6012, po: '6012' }), 'RO #6012');
  assert.equal(roLabel({ ro_number: null, po: '5473' }), 'PO 5473');
  const long = 'Customer called twice about the transmission slipping between gears, needs starter bolts for the F-250 before Friday';
  assert.match(noteSnippet(long, ['starter']), /starter bolts/);
  assert.ok(noteSnippet(long, ['starter']).length <= 72);
});

test('destinations: customer → record; vehicle → owner (survivor if merged); RO → RO; call with customer → record at that call; call without → call log', () => {
  const merged = (c) => (c && c.merged_into ? String(c.merged_into) : null);
  assert.deepEqual(destination('customer', { id: 7 }), { to: 'customer', id: '7' });
  assert.deepEqual(destination('vehicle', { id: 'v', customer_id: 9, owner: { id: 9 } }, { mergedIntoId: merged }), { to: 'customer', id: '9' });
  assert.deepEqual(destination('vehicle', { id: 'v', customer_id: 9, owner: { id: 9, merged_into: 1 } }, { mergedIntoId: merged }), { to: 'customer', id: '1' });
  assert.deepEqual(destination('ro', { id: 'r1' }), { to: 'ro', id: 'r1' });
  assert.deepEqual(destination('call', { id: 55, customer_id: 'c1', started_at: '2026-09-20T14:00:00Z' }),
    { to: 'customer-call', id: 'c1', callId: '55' });
  assert.deepEqual(destination('call', { id: 56, customer_id: null, started_at: '2026-09-20T14:00:00Z' }),
    { to: 'call-log', when: '2026-09-20T14:00:00Z', callId: '56' });   // never the guessed customer
  assert.deepEqual(destination('call', { id: 57, customer_id: null, started_at: null }), { to: 'desk' });
});

test('keyboard: the flat list walks the groups in order, wraps both ways', () => {
  const groups = { customer: [1, 2], ro: [3], call: Array.from({ length: 9 }, (_, i) => 10 + i) };
  const flat = flattenGroups(groups, ['ro', 'customer', 'vehicle', 'call']);
  assert.deepEqual(flat.slice(0, 3).map((f) => f.kind + f.item), ['ro3', 'customer1', 'customer2']);
  assert.equal(flat.filter((f) => f.kind === 'call').length, PER_GROUP);
  assert.equal(moveSelection(-1, 1, 5), 0);
  assert.equal(moveSelection(-1, -1, 5), 4);
  assert.equal(moveSelection(4, 1, 5), 0);
  assert.equal(moveSelection(0, -1, 5), 4);
  assert.equal(moveSelection(0, 1, 0), -1);
});

test('"/" focuses the search — never while typing in another field (same rule as the Desk pad\'s N)', () => {
  assert.match(ui, /import \{ isTypingTarget \} from '\.\/desk-pad-logic\.js';/);
  assert.match(ui, /if \(ev\.key !== '\/' \|\| ev\.ctrlKey \|\| ev\.metaKey \|\| ev\.altKey \|\| ev\.defaultPrevented\) return;/);
  assert.match(ui, /if \(isTypingTarget\(document\.activeElement\) \|\| isTypingTarget\(ev\.target\)\) return;/);
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
});

test('static: one "+ New RO" (the top bar), the bar mounted once, reads only', () => {
  assert.doesNotMatch(board, /id="cdRoNewBtn"/);
  assert.doesNotMatch(board, /\$\('cdRoNewBtn'\)/);
  assert.equal((ui.match(/newBtn\.textContent = '\+ New RO'/g) || []).length, 1);
  assert.match(ui, /window\.cdOpenNewRo\(\)/);
  assert.equal((board.match(/mountGlobalSearch\(\{ db \}\)/g) || []).length, 1);
  assert.equal((board.match(/shared\/global-search\.css/g) || []).length, 1);
  const code = ui.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\.(insert|update|upsert|delete)\s*\(|\.rpc\(|cdAuthFetch|\bfetch\(/);
});

test('static: the Customers tab lost its own search box, kept the A–Z browse; the board opens calls for search', () => {
  assert.doesNotMatch(board, /id="custSearchInput"/);
  assert.doesNotMatch(board, /custSearchInput/);
  assert.match(board, /<div id="custAzBar" class="cust-az-bar"/);
  assert.match(board, /<div id="custSearchList" class="cust-search-list">/);
  assert.match(board, /id="custVehSearch"/);                                  // per-customer vehicle filter stays
  assert.match(board, /window\.cdOpenCustomerAtCall = \(id, callId\) =>/);
  assert.match(board, /data-cust-call="\$\{esc\(String\(c\.id\)\)\}"/);
  assert.match(board, /window\.cdDeskOpenLogAt = \(when, callId\) =>/);
  assert.match(board, /data-log-call="\$\{esc\(String\(c\.id\)\)\}"/);
  assert.match(board, /if \(window\.cdGlobalSearch\) window\.cdGlobalSearch\.open\(phone \|\| ''\);/);   // ambiguous phone → search
});
