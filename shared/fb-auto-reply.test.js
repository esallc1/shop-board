/* ============================================================
   fb-auto-reply.test.js — the Facebook after-hours auto-reply's pure rules.
   Run: npm test   (node --test)

   Locks: shop hours (Mon–Fri 8am–5pm America/New_York, DST-correct, the
   "Shop closed today" date), the closed STRETCH the one-reply rule keys on,
   the send decision, the US-phone parser, and that the Settings copy of the
   default text is byte-identical to the webhook's.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isShopOpen, closedStretchStart, closedTodayActive, etYmd, etToUtc } from './shop-hours.js';
import { shouldAutoReply, findUsPhone, autoReplyText, DEFAULT_AUTO_REPLY_TEXT, MAX_AUTO_REPLY_CHARS, AUTO_METADATA } from './fb-auto-reply.js';

const here = dirname(fileURLToPath(import.meta.url));
const T = (iso) => Date.parse(iso);

/* ── 1. Open / closed ──────────────────────────────────────────────────── */
test('Friday: 4:59pm open, 5:00pm closed (EDT)', () => {
  assert.equal(isShopOpen(T('2026-09-25T20:59:00Z')), true);    // Fri 4:59pm EDT
  assert.equal(isShopOpen(T('2026-09-25T21:00:00Z')), false);   // Fri 5:00pm EDT
  assert.equal(closedStretchStart(T('2026-09-25T21:00:00Z')), T('2026-09-25T21:00:00Z'));
});

test('Saturday and Sunday are closed — the same stretch as Friday night', () => {
  const fri5 = T('2026-09-25T21:00:00Z');
  for (const iso of ['2026-09-26T14:00:00Z', '2026-09-26T03:00:00Z', '2026-09-27T16:00:00Z', '2026-09-28T03:59:00Z']) {
    assert.equal(isShopOpen(T(iso)), false, iso);
    assert.equal(closedStretchStart(T(iso)), fri5, iso);
  }
});

test('Monday: 7:59am closed (still the weekend stretch), 8:00am open', () => {
  assert.equal(isShopOpen(T('2026-09-28T11:59:00Z')), false);
  assert.equal(closedStretchStart(T('2026-09-28T11:59:00Z')), T('2026-09-25T21:00:00Z'));
  assert.equal(isShopOpen(T('2026-09-28T12:00:00Z')), true);
});

test('weekday nights are their own stretch; midday is open', () => {
  assert.equal(isShopOpen(T('2026-09-23T14:00:00Z')), true);                          // Wed 10am
  assert.equal(closedStretchStart(T('2026-09-24T02:00:00Z')), T('2026-09-23T21:00:00Z'));   // Wed 10pm
  assert.equal(closedStretchStart(T('2026-09-24T10:00:00Z')), T('2026-09-23T21:00:00Z'));   // Thu 6am
});

test('DST fall-back weekend (Nov 1 2026): Friday 5pm EDT → Monday 8am EST', () => {
  const fri5 = T('2026-10-30T21:00:00Z');                    // Fri 5pm EDT
  assert.equal(closedStretchStart(T('2026-11-01T15:00:00Z')), fri5);   // Sun
  assert.equal(isShopOpen(T('2026-11-02T12:59:00Z')), false);          // Mon 7:59am EST
  assert.equal(closedStretchStart(T('2026-11-02T12:59:00Z')), fri5);
  assert.equal(isShopOpen(T('2026-11-02T13:00:00Z')), true);           // Mon 8:00am EST
  assert.equal(isShopOpen(T('2026-11-02T21:59:00Z')), true);           // Mon 4:59pm EST
  assert.equal(isShopOpen(T('2026-11-02T22:00:00Z')), false);          // Mon 5:00pm EST
});

test('DST spring-forward weekend (Mar 14 2027): Friday 5pm EST → Monday 8am EDT', () => {
  const fri5 = T('2027-03-12T22:00:00Z');                    // Fri 5pm EST
  assert.equal(closedStretchStart(T('2027-03-14T15:00:00Z')), fri5);
  assert.equal(isShopOpen(T('2027-03-15T11:59:00Z')), false);          // Mon 7:59am EDT
  assert.equal(isShopOpen(T('2027-03-15T12:00:00Z')), true);           // Mon 8:00am EDT
  assert.equal(etToUtc(2027, 3, 15, 8), T('2027-03-15T12:00:00Z'));
  assert.equal(etToUtc(2027, 3, 12, 17), fri5);
});

test('"Shop closed today" — active only on its own ET date; yesterday\'s has expired', () => {
  const wed10 = T('2026-09-23T14:00:00Z');
  assert.equal(closedTodayActive('2026-09-23', wed10), true);
  assert.equal(isShopOpen(wed10, '2026-09-23'), false);
  assert.equal(closedStretchStart(wed10, '2026-09-23'), T('2026-09-22T21:00:00Z'));   // since Tue 5pm
  assert.equal(closedTodayActive('2026-09-22', wed10), false);
  assert.equal(isShopOpen(wed10, '2026-09-22'), true);                  // expired → normal hours
  assert.equal(isShopOpen(wed10, null), true);
  // ends at midnight ET: Wed 11:59pm still set, Thu 8am open again
  assert.equal(closedTodayActive('2026-09-23', T('2026-09-24T03:59:00Z')), true);
  assert.equal(closedTodayActive('2026-09-23', T('2026-09-24T04:00:00Z')), false);
  assert.equal(isShopOpen(T('2026-09-24T12:00:00Z'), '2026-09-23'), true);
  // after midnight the closed day is still history: Thu 1am is the same stretch (since Tue 5pm)
  assert.equal(closedStretchStart(T('2026-09-24T05:00:00Z'), '2026-09-23'), T('2026-09-22T21:00:00Z'));
});

test('etYmd is the shop-time date (UTC midnight is still yesterday in Florida)', () => {
  assert.equal(etYmd(T('2026-09-24T02:00:00Z')), '2026-09-23');
  assert.equal(etYmd(T('2026-09-24T04:00:00Z')), '2026-09-24');
});

/* ── 2. The send decision ──────────────────────────────────────────────── */
const SAT = T('2026-09-26T14:00:00Z');
test('closed + nothing sent in this stretch → send', () => {
  assert.deepEqual(shouldAutoReply({ enabled: true, atMs: SAT }), { send: true, reason: 'closed', stretchStart: T('2026-09-25T21:00:00Z') });
});
test('switched off / open / no time → no send', () => {
  assert.equal(shouldAutoReply({ enabled: false, atMs: SAT }).reason, 'switched-off');
  assert.equal(shouldAutoReply({ enabled: true, atMs: T('2026-09-23T14:00:00Z') }).reason, 'shop-open');
  assert.equal(shouldAutoReply({ enabled: true, atMs: NaN }).reason, 'no-time');
});
test('one auto-reply per stretch: Friday night\'s covers Saturday; last week\'s does not', () => {
  const friNight = '2026-09-26T01:30:00Z';
  assert.equal(shouldAutoReply({ enabled: true, atMs: SAT, lastAutoReplyAt: friNight }).reason, 'already-replied-this-stretch');
  assert.equal(shouldAutoReply({ enabled: true, atMs: SAT, lastAutoReplyAt: '2026-09-24T02:00:00Z' }).send, true);
});
test('a staff reply in the stretch → no auto-reply; one from before the stretch doesn\'t count', () => {
  assert.equal(shouldAutoReply({ enabled: true, atMs: SAT, lastStaffReplyAt: '2026-09-25T22:10:00Z' }).reason, 'staff-replied-this-stretch');
  assert.equal(shouldAutoReply({ enabled: true, atMs: SAT, lastStaffReplyAt: '2026-09-25T20:00:00Z' }).send, true);
});
test('closed today during open hours → send', () => {
  assert.equal(shouldAutoReply({ enabled: true, atMs: T('2026-09-23T14:00:00Z'), closedYmd: '2026-09-23' }).send, true);
});

/* ── 3. The text ───────────────────────────────────────────────────────── */
test('saved text is sent exactly; blank → the default; capped at 2000', () => {
  assert.equal(autoReplyText('Cerrado — ¡vuelva mañana! ñ é ü'), 'Cerrado — ¡vuelva mañana! ñ é ü');
  assert.equal(autoReplyText('  line one\n\nline two  '), '  line one\n\nline two  ');
  assert.equal(autoReplyText(null), DEFAULT_AUTO_REPLY_TEXT);
  assert.equal(autoReplyText('   \n '), DEFAULT_AUTO_REPLY_TEXT);
  assert.equal(autoReplyText('x'.repeat(2500)).length, MAX_AUTO_REPLY_CHARS);
  assert.equal(AUTO_METADATA, 'crisdata:auto');
});
test('the default text: two languages separated by one blank line', () => {
  const parts = DEFAULT_AUTO_REPLY_TEXT.split('\n\n');
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith('Thanks for messaging Lee Transmission!'));
  assert.ok(parts[1].startsWith('¡Gracias por escribir a Lee Transmission!'));
  assert.ok(DEFAULT_AUTO_REPLY_TEXT.endsWith('buzón para llaves 24/7 en la puerta principal.'));
});
test('Settings\' copy of the default text is identical to the webhook\'s', () => {
  const src = readFileSync(join(here, 'board-settings.js'), 'utf8');
  const m = /const FB_DEFAULT_TEXT =\s*([\s\S]*?);\n/.exec(src);
  assert.ok(m, 'FB_DEFAULT_TEXT not found in board-settings.js');
  const copy = new Function('return ' + m[1])();
  assert.equal(copy, DEFAULT_AUTO_REPLY_TEXT);
});

/* ── 4. Phone numbers in a customer's message ──────────────────────────── */
test('findUsPhone: the common US formats → 10 digits', () => {
  for (const s of ['call me (239) 555-1234 please', '239-555-1234', '2395551234', '+1 239 555 1234',
    '12395551234', '239.555.1234', '1-239-555-1234', 'Maria, +1 (239) 555-1234, 2014 Camry'])
    assert.equal(findUsPhone(s), '2395551234', s);
});
test('findUsPhone: not a phone → null (VIN, RO number, short, bad area code, empty)', () => {
  for (const s of ['VIN 1HGCM82633A004352', 'RO #6012 PO 5473', '555-1234', '(123) 555-1234', '239 555 12345',
    '', null, undefined, 'my truck is a 2014 f150'])
    assert.equal(findUsPhone(s), null, String(s));
});
