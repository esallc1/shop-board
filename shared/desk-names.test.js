import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GUESS_TOOLTIP, custDisplayName, buildPhoneIndex, customerIdsToLoad, deskName, isGuess, textLabel,
} from './desk-names.js';

const OMAR = { id: 'c-omar', name: 'OMAR MADRID', phone_primary: '(239) 555-0101' };
const ANA = { id: 'c-ana', name: 'ANA ROJAS', phone_primary: '2395550202' };
const ANA_SPOUSE = { id: 'c-luis', name: 'LUIS ROJAS', phone_secondary: '+1 239-555-0202' };
const GONE = { id: 'c-gone', name: 'OLD DUPLICATE', phone_primary: '2395550303', archived_at: '2026-09-01T00:00:00Z' };
const KEEP = { id: 'c-keep', name: 'KEEPER', phone_primary: '2395550303' };
const BIZ = { id: 'c-biz', name: 'x', business_name: 'ACME TOWING', phone_primary: '2395550404' };
const ALL = [OMAR, ANA, ANA_SPOUSE, GONE, KEEP, BIZ];
const byId = Object.fromEntries(ALL.map(c => [c.id, c]));
const byPhone = buildPhoneIndex(ALL);
const phoneLabel = (c) => `PHONE ${c.caller_bare}`;
const O = { byId, byPhone, phoneLabel };
const ctm = (o) => ({ id: 1, ctm_call_id: 4382198663, ...o });      // a real CTM call
const manual = (o) => ({ id: 2, ctm_call_id: -1789987844443599, ...o }); // made by "+Add"

test('1. customer_id → that customer, confirmed (business name wins)', () => {
  const r = deskName(ctm({ customer_id: 'c-omar', caller_bare: '2395550202' }), O);
  assert.deepEqual([r.kind, r.label, r.confirmed], ['linked', 'OMAR MADRID', true]);   // link beats the phone
  assert.equal(deskName(ctm({ customer_id: 'c-biz' }), O).label, 'ACME TOWING');
});

test('1b. linked but the customer did not load → the phone, never a phone guess', () => {
  const r = deskName(ctm({ customer_id: 'c-missing', caller_bare: '2395550101' }), O);
  assert.deepEqual([r.kind, r.label, r.confirmed], ['phone', 'PHONE 2395550101', false]);
});

test('2. a "+Add" row\'s typed name is confirmed, and beats a phone match', () => {
  const r = deskName(manual({ cnam: '  ZZ KEYBOX TEST ', caller_bare: '2395550101' }), O);
  assert.deepEqual([r.kind, r.label, r.confirmed], ['typed', 'ZZ KEYBOX TEST', true]);
});

test('CTM caller-ID cnam is ignored (it is often a city)', () => {
  const city = deskName(ctm({ cnam: 'FORT MYERS   FL', caller_bare: '9995550000' }), O);
  assert.deepEqual([city.kind, city.label], ['phone', 'PHONE 9995550000']);
  const person = deskName(ctm({ cnam: 'GISELLE NAVARRO', caller_bare: '2395550101' }), O);
  assert.deepEqual([person.kind, person.label], ['guess', 'OMAR MADRID']);   // falls through to the phone step
});

test('3. exactly one customer on the phone → a guess', () => {
  const r = deskName(ctm({ caller_bare: '+1 (239) 555-0101' }), O);
  assert.deepEqual([r.kind, r.label, r.confirmed, r.customer.id], ['guess', 'OMAR MADRID', false, 'c-omar']);
  assert.equal(isGuess(r), true);
  assert.equal(textLabel(r), 'OMAR MADRID ?');
});

test('4. two customers on the phone (primary + secondary) → "2 customers on this number", never one picked', () => {
  const r = deskName(ctm({ caller_bare: '2395550202' }), O);
  assert.deepEqual([r.kind, r.label, r.customer], ['multi', '2 customers on this number', null]);
  assert.deepEqual(r.candidates.map(c => c.id).sort(), ['c-ana', 'c-luis']);
});

test('archived customers are never the guess and never counted', () => {
  const r = deskName(ctm({ caller_bare: '2395550303' }), O);
  assert.deepEqual([r.kind, r.label], ['guess', 'KEEPER']);                 // not "2 customers"
  assert.equal(buildPhoneIndex([GONE])['2395550303'], undefined);
  // …even if an archived row sneaks into a hand-built index
  const leaky = { '2395550303': [GONE] };
  assert.equal(deskName(ctm({ caller_bare: '2395550303' }), { ...O, byPhone: leaky }).kind, 'phone');
});

test('a call a human marked "not a customer" is never guessed', () => {
  const r = deskName(ctm({ caller_bare: '2395550101', not_a_customer_at: '2026-09-01T00:00:00Z' }), O);
  assert.equal(r.kind, 'phone');
});

test('5. no link, no typed name, no match → the phone (today\'s fallback)', () => {
  assert.deepEqual(deskName(ctm({ caller_bare: '9995550099' }), O).label, 'PHONE 9995550099');
  assert.equal(deskName(ctm({ caller_bare: '2395550101' }), { byId, phoneLabel }).kind, 'phone');   // no phone index
  assert.equal(deskName(null, O).kind, 'phone');
});

test('buildPhoneIndex: last-10 on both phones, deduped, archived dropped', () => {
  const idx = buildPhoneIndex([OMAR, { ...OMAR, phone_secondary: '2395550101' }, GONE, { id: 'x', phone_primary: '123' }]);
  assert.deepEqual(Object.keys(idx), ['2395550101']);
  assert.equal(idx['2395550101'].length, 1);
});

test('customerIdsToLoad: cleared rows are looked up too (the Recently-cleared bug)', () => {
  const open = [{ customer_id: 'c-omar' }, { customer_id: null }];
  const cleared = [{ customer_id: 'c-ana' }, { customer_id: 'c-omar' }];
  assert.deepEqual(customerIdsToLoad(open, cleared).sort(), ['c-ana', 'c-omar']);
  assert.deepEqual(customerIdsToLoad([], cleared).sort(), ['c-ana', 'c-omar']);   // no open rows at all
  assert.deepEqual(customerIdsToLoad(null, undefined), []);
});

test('wording', () => {
  assert.equal(GUESS_TOOLTIP, 'Matched by phone — not confirmed');
  assert.equal(custDisplayName(null), '(no name)');
  assert.equal(textLabel(deskName(ctm({ customer_id: 'c-omar' }), O)), 'OMAR MADRID');
});

// ── board wiring ──
test('board: lanes resolve names through DeskNames, cleared rows get their own lookup, cnam is selected', () => {
  const html = readFileSync(new URL('../advisor-board.html', import.meta.url), 'utf8');
  assert.match(html, /const CALL_COLS = '[^']*\bcnam\b/);
  assert.match(html, /customerIdsToLoad\(calls, cleared\)/);
  assert.match(html, /import \* as DeskNames from '\.\/shared\/desk-names\.js'/);
  assert.match(html, /\.desk-recovered-banner \{[^}]*box-shadow:0 0 0 6px #E1F5EE;/);
});
