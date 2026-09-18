/* ============================================================
   new-badge.test.js — the NEW pill's show/hide rule.
   Run: npm test   (node --test)

   Locks: shows the day before `data-new-until`, hides ON it and after, hides
   on a missing/garbage/impossible date (never stuck on), and decides in shop
   time (America/New_York), not UTC — 9pm ET the day before is already the
   next day in UTC and must still show.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shopToday, parseUntil, isNewBadgeVisible, applyNewBadges } from './new-badge.js';

const UNTIL = '2026-09-26';
// Noon ET on a given day (EDT = UTC-4 in September).
const noonET = (ymd) => new Date(ymd + 'T16:00:00Z');

test('shows the day before the until date', () => {
  assert.equal(isNewBadgeVisible(UNTIL, noonET('2026-09-25')), true);
  assert.equal(isNewBadgeVisible(UNTIL, noonET('2026-09-18')), true);
});

test('hides ON the until date and after it', () => {
  assert.equal(isNewBadgeVisible(UNTIL, noonET('2026-09-26')), false);
  assert.equal(isNewBadgeVisible(UNTIL, new Date('2026-09-26T04:00:00Z')), false);   // 00:00 ET on the 26th
  assert.equal(isNewBadgeVisible(UNTIL, noonET('2026-09-27')), false);
  assert.equal(isNewBadgeVisible(UNTIL, noonET('2027-01-01')), false);
});

test('last moment before midnight ET still shows; the first moment of the date hides', () => {
  assert.equal(isNewBadgeVisible(UNTIL, new Date('2026-09-26T03:59:59Z')), true);    // 23:59:59 ET on the 25th
  assert.equal(isNewBadgeVisible(UNTIL, new Date('2026-09-26T04:00:00Z')), false);
});

test('uses New York time, not UTC: 9pm ET the day before is already the date in UTC', () => {
  const ninePmET = new Date('2026-09-26T01:00:00Z');       // Fri Sep 25, 21:00 EDT
  assert.equal(ninePmET.toISOString().slice(0, 10), '2026-09-26');   // UTC already says the 26th…
  assert.equal(shopToday(ninePmET), '2026-09-25');                     // …the shop says the 25th
  assert.equal(isNewBadgeVisible(UNTIL, ninePmET), true);
});

test('New York time in winter (EST, UTC-5) too', () => {
  const tenPmEST = new Date('2027-01-15T03:00:00Z');       // Thu Jan 14, 22:00 EST
  assert.equal(shopToday(tenPmEST), '2027-01-14');
  assert.equal(isNewBadgeVisible('2027-01-15', tenPmEST), true);
});

test('missing or garbage dates are HIDDEN — never stuck showing', () => {
  const now = noonET('2026-09-18');
  for (const bad of [undefined, null, '', '   ', 'soon', 'NEW', '2026-9-26', '09/26/2026',
                     '2026-09-26T00:00', '2026-02-30', '2026-13-01', '2026-00-10', '99999-01-01', 20260926]) {
    assert.equal(isNewBadgeVisible(bad, now), false, 'showed for ' + JSON.stringify(bad));
  }
});

test('parseUntil accepts only a real YYYY-MM-DD day', () => {
  assert.equal(parseUntil('2026-09-26'), '2026-09-26');
  assert.equal(parseUntil(' 2026-09-26 '), '2026-09-26');
  assert.equal(parseUntil('2028-02-29'), '2028-02-29');   // leap day
  assert.equal(parseUntil('2027-02-29'), null);
});

test('a bad clock value is hidden, not shown', () => {
  assert.equal(isNewBadgeVisible(UNTIL, new Date('nope')), false);
});

test('applyNewBadges only toggles .is-on, per element', () => {
  const mk = (until) => {
    const cls = new Set(['cd-new']);
    return { getAttribute: () => until, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) }, cls };
  };
  const els = [mk('2026-09-26'), mk('2026-09-18'), mk(null), mk('junk')];
  const root = { querySelectorAll: () => els };
  assert.equal(applyNewBadges(root, noonET('2026-09-18')), 1);
  assert.deepEqual(els.map((e) => e.cls.has('is-on')), [true, false, false, false]);
});

test('CSS: hidden by default, not clickable, 3 pulses, reduced-motion stops it', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'new-badge.css'), 'utf8');
  assert.match(css, /\.cd-new \{ display: none; \}/);
  assert.match(css, /pointer-events: none;/);
  assert.match(css, /animation: cd-new-glow [^;]* 3;/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*animation: none;/);
});
