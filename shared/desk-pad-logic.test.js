/* ============================================================
   desk-pad-logic.test.js — the Desk pad's rules.
   Run: npm test   (node --test)

   Locks: add / delete / edit / tear off; storage that works, is empty, holds
   junk, or THROWS on every call (private mode / blocked site data) — the pad
   keeps working in memory; the N key never fires while typing or with a
   modifier; and (static) the pad code touches no database and no network.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STORAGE_KEY, MAX_NOTES, addNote, deleteNote, updateNoteText, tearOff, cleanNotes,
  loadNotes, saveNotes, isTypingTarget, isPadToggleKey, noteTime,
  padHeight, pushScrollTarget, CAP_RATIO, ONE_ROW_MIN,
} from './desk-pad-logic.js';

const here = dirname(fileURLToPath(import.meta.url));
let n = 0;
const idGen = () => 'id' + (++n);
const AT = new Date('2026-09-23T14:31:00Z');   // 10:31 in shop time

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, _m: m };
}
const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };

test('add: an empty note at the end with a shop-time stamp; input untouched', () => {
  const start = [{ id: 'a', text: 'starter bolts', time: '9:05' }];
  const copy = JSON.stringify(start);
  const { notes, note } = addNote(start, { now: AT, idGen });
  assert.equal(notes.length, 2);
  assert.deepEqual(note, { id: note.id, text: '', time: '10:31' });
  assert.equal(notes[1], note);
  assert.equal(JSON.stringify(start), copy);
  assert.equal(noteTime(AT), '10:31');
});

test('add: several notes at once, each its own id; capped at MAX_NOTES', () => {
  let notes = [];
  for (let i = 0; i < 3; i++) notes = addNote(notes, { now: AT, idGen }).notes;
  assert.equal(new Set(notes.map((x) => x.id)).size, 3);
  const full = Array.from({ length: MAX_NOTES }, (_, i) => ({ id: 'f' + i, text: '', time: '' }));
  const r = addNote(full, { now: AT, idGen });
  assert.equal(r.note, null);
  assert.equal(r.notes.length, MAX_NOTES);
});

test('delete removes only that note; edit changes only its text; tear off empties the pad', () => {
  const notes = [{ id: 'a', text: 'one', time: '9:00' }, { id: 'b', text: 'two', time: '9:01' }, { id: 'c', text: 'three', time: '9:02' }];
  assert.deepEqual(deleteNote(notes, 'b').map((x) => x.id), ['a', 'c']);
  assert.deepEqual(deleteNote(notes, 'zzz').map((x) => x.id), ['a', 'b', 'c']);
  const edited = updateNoteText(notes, 'c', 'call Suncoast after lunch');
  assert.equal(edited[2].text, 'call Suncoast after lunch');
  assert.equal(edited[0].text, 'one');
  assert.equal(edited[2].time, '9:02');
  assert.deepEqual(tearOff(), []);
});

test('storage: save then load round-trips (survives a refresh)', () => {
  const s = memStorage();
  const notes = [{ id: 'a', text: 'starter bolts — Ford F-250, customer X', time: '10:31' }];
  assert.equal(saveNotes(() => s, notes), true);
  assert.ok(s._m.has(STORAGE_KEY));
  assert.deepEqual(loadNotes(() => s), notes);
});

test('storage that THROWS (or is missing) never breaks the pad: load → [], save → false', () => {
  assert.deepEqual(loadNotes(() => throwing), []);
  assert.equal(saveNotes(() => throwing, [{ id: 'a', text: 'x', time: '' }]), false);
  assert.deepEqual(loadNotes(() => { throw new Error('localStorage access denied'); }), []);
  assert.equal(saveNotes(() => { throw new Error('denied'); }, []), false);
  assert.deepEqual(loadNotes(() => null), []);
  // and the in-memory flow still works with no storage at all
  let notes = addNote([], { now: AT, idGen }).notes;
  notes = updateNoteText(notes, notes[0].id, 'still works');
  assert.equal(notes[0].text, 'still works');
});

test('storage holding junk is cleaned, never trusted', () => {
  const s = memStorage();
  s.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(loadNotes(() => s), []);
  s.setItem(STORAGE_KEY, JSON.stringify({ v: 1, notes: [null, 5, { id: 'a', text: 7 }, { id: 'a', text: 'dup' }, { text: 'no id' }, { id: 'b', text: 'ok', time: '9:00' }] }));
  assert.deepEqual(loadNotes(() => s), [{ id: 'a', text: '', time: '' }, { id: 'b', text: 'ok', time: '9:00' }]);
  s.setItem(STORAGE_KEY, JSON.stringify([{ id: 'x', text: 'old array shape', time: '8:00' }]));
  assert.deepEqual(loadNotes(() => s), [{ id: 'x', text: 'old array shape', time: '8:00' }]);
  assert.deepEqual(cleanNotes('nope'), []);
});

test('N key: toggles only when nobody is typing and no modifier is held', () => {
  const body = { tagName: 'BODY' };
  const key = (k, extra = {}) => ({ key: k, target: body, ...extra });
  assert.equal(isPadToggleKey(key('n'), body), true);
  assert.equal(isPadToggleKey(key('N'), body), true);
  assert.equal(isPadToggleKey(key('m'), body), false);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'isComposing', 'defaultPrevented']) {
    assert.equal(isPadToggleKey(key('n', { [mod]: true }), body), false, mod);
  }
  const typing = [
    { tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'search' }, { tagName: 'INPUT' },
    { tagName: 'textarea' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true },
  ];
  for (const el of typing) {
    assert.equal(isPadToggleKey(key('n', { target: el }), el), false, JSON.stringify(el));
    assert.equal(isTypingTarget(el), true);
  }
  // a focused button / checkbox is not typing
  assert.equal(isPadToggleKey(key('n'), { tagName: 'BUTTON' }), true);
  assert.equal(isPadToggleKey(key('n'), { tagName: 'INPUT', type: 'checkbox' }), true);
  assert.equal(isPadToggleKey(null, body), false);
});

test('static: the desk pad touches no database and no network', () => {
  for (const f of ['desk-pad.js', 'desk-pad-logic.js']) {
    const src = readFileSync(join(here, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /supabase|\bdb\b|\.from\(|\.rpc\(|\.channel\(/i, f + ' talks to the database');
    assert.doesNotMatch(src, /\bfetch\(|cdAuthFetch|XMLHttpRequest|\/api\//, f + ' makes a network call');
  }
  const board = readFileSync(join(here, '..', 'advisor-board.html'), 'utf8');
  assert.equal((board.match(/mountDeskPad\(\)/g) || []).length, 1, 'mounted exactly once');
  assert.equal((board.match(/shared\/desk-pad\.css/g) || []).length, 1);
});

/* ── Height: start short, grow as needed (Cris, 2026-09-23) ─────────────── */
const CHROME = 46;          // the pad's top bar
const ROW1 = 132, ROW2 = 254, ROW3 = 376;   // 1, 2, 3 rows of stickies (+ grid padding)

test('height: ONE row to start — header + one row, about a quarter of a laptop window', () => {
  assert.equal(padHeight(CHROME, ROW1, 720), CHROME + ROW1);        // 178 px
  assert.ok(padHeight(CHROME, ROW1, 720) / 720 < 0.26);
  assert.equal(padHeight(CHROME, 0, 720), CHROME + ONE_ROW_MIN);     // empty pad still shows a row (the + New note tile)
});

test('height: grows to fit a 2nd row, then stops at 45% of the window (notes scroll inside)', () => {
  assert.equal(padHeight(CHROME, ROW2, 720), CHROME + ROW2);        // 300 ≤ 324 → fits
  assert.equal(padHeight(CHROME, ROW3, 720), Math.round(720 * CAP_RATIO));   // 422 > 324 → capped
  assert.equal(padHeight(CHROME, 5000, 900), Math.round(900 * 0.45));
  assert.equal(CAP_RATIO, 0.45);
});

test('height: shrinks back as rows empty; never below header + one row, even on a short window', () => {
  const grown = padHeight(CHROME, ROW2, 720);
  const shrunk = padHeight(CHROME, ROW1, 720);
  assert.ok(shrunk < grown);
  assert.equal(padHeight(CHROME, ROW3, 300), CHROME + ONE_ROW_MIN); // 45% of 300 = 135 < header + a row
  assert.equal(padHeight('junk', null, undefined), ONE_ROW_MIN);
});

test('push follows the real height: the page moves by exactly the change, never above the top', () => {
  assert.equal(pushScrollTarget(0, 0, 178), 178);        // open: up by the pad height
  assert.equal(pushScrollTarget(178, 178, 300), 300);    // a 2nd row: up by the extra 122
  assert.equal(pushScrollTarget(300, 300, 178), 178);    // a note deleted: back down by 122
  assert.equal(pushScrollTarget(50, 300, 178), 0);       // clamped at the top
});
