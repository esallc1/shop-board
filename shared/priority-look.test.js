/* ============================================================
   priority-look.test.js — the shared Immediate / High / Normal / Low look.
   Run: npm test   (node --test)

   Locks (docs/wiring/todo-list.md §3): the old thin red/amber edge rules
   (Immediate vs High 1.75:1 — Kevin, 2026-08-06) are gone; the To-Do list
   (4 boards) and Report a change both use the ONE shared set of classes in
   shared/board-shell.css; the level is always a word; and the new colours
   pass WCAG (text ≥ 4.5:1, edges ≥ 3:1 against the row background).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const css = read('shared/board-shell.css');
const rc = read('shared/report-change.js');
const BOARDS = ['advisor-board.html', 'gm-board.html', 'owner-board.html', 'bookkeeping-board.html'];

function rule(sel) {
  const i = css.indexOf(sel + ' ');
  assert.ok(i >= 0, 'missing CSS rule ' + sel);
  return css.slice(i, css.indexOf('}', i));
}
function lum(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('the old thin-edge-only rules and old tags are gone', () => {
  assert.ok(!/\.todo-item\.todo-prio-(immediate|high|normal|low)/.test(css), 'old To-Do edge rules still in board-shell.css');
  assert.ok(!/\.todo-prio-tag/.test(css), 'old .todo-prio-tag rules still in board-shell.css');
  assert.ok(!/\.rc-(mine-)?item\.prio-(immediate|high|normal|low)/.test(rc), 'report-change.js still carries its own edge copies');
  assert.ok(!/todo-prio-tag/.test(rc), 'report-change.js still uses the old tag');
  for (const f of BOARDS) {
    const src = read(f);
    assert.ok(!/todo-prio-tag/.test(src), f + ' still renders the old tag');
    assert.ok(!/class="todo-item todo-prio-/.test(src), f + ' still uses the old row class');
  }
});

test('shared look: Immediate filled dark red, High outlined dark orange', () => {
  assert.match(rule('.prio-edge.prio-edge-immediate'), /border-left:\s*5px solid #b91c1c/);
  assert.match(rule('.prio-edge.prio-edge-high'), /border-left:\s*5px solid #b45309/);
  const imm = rule('.prio-pill.prio-pill-immediate');
  assert.match(imm, /background:\s*#b91c1c/);
  assert.match(imm, /color:\s*#fff/);
  assert.match(imm, /text-transform:\s*uppercase/);
  const high = rule('.prio-pill.prio-pill-high');
  assert.match(high, /background:\s*#fff/);
  assert.match(high, /border-color:\s*#b45309/);
  assert.match(high, /color:\s*#b45309/);
  assert.match(rule('.prio-pill.prio-pill-normal'), /background:\s*none/);   // a word, not a pill
  assert.match(rule('.prio-pill.prio-pill-low'), /background:\s*#f3f4f6/);
});

test('both features use the shared classes; the word shows on every open To-Do row', () => {
  assert.equal((rc.match(/class="prio-pill prio-pill-\$\{esc\(r\.priority\)\}"/g) || []).length, 2, 'Report a change pills (My reports + inbox)');
  assert.match(rc, /class="rc-mine-item prio-edge prio-edge-\$\{esc\(r\.priority\)\}/);
  assert.match(rc, /class="rc-item prio-edge prio-edge-\$\{esc\(r\.priority\)\}/);
  for (const f of BOARDS) {
    const src = read(f);
    assert.match(src, /class="todo-item prio-edge prio-edge-\$\{priority\}/, f + ' row edge');
    assert.match(src, /class="todo-prio-select prio-pill prio-pill-\$\{priority\}"/, f + ' creator dropdown pill');
    assert.match(src, /<span class="prio-pill prio-pill-\$\{priority\}"/, f + ' read-only pill');
    // outside the manage-only actions, so non-managers see the word too
    const i = src.indexOf('<div class="todo-prio">${prioControl}</div>');
    const j = src.indexOf('<div class="todo-actions">', i);
    assert.ok(i >= 0 && j > i, f + ': the priority must render before/outside the canManage actions');
    assert.ok(!/<div class="todo-actions">\s*\$\{prioControl\}/.test(src), f + ': priority still inside the actions');
  }
});

test('the new colours pass WCAG', () => {
  const ROW_BG = '#f5f6fa', WHITE = '#ffffff';
  assert.ok(ratio('#ffffff', '#b91c1c') >= 4.5, 'IMMEDIATE text');
  assert.ok(ratio('#b45309', WHITE) >= 4.5, 'High text');
  assert.ok(ratio('#4b5563', '#f3f4f6') >= 4.5, 'Low text');
  assert.match(rule('.prio-pill.prio-pill-normal'), /color:\s*#646b7e/);
  assert.ok(ratio('#646b7e', ROW_BG) >= 4.5 && ratio('#646b7e', WHITE) >= 4.5, 'Normal word');
  assert.ok(ratio('#b91c1c', ROW_BG) >= 3 && ratio('#b91c1c', WHITE) >= 3, 'Immediate edge');
  assert.ok(ratio('#b45309', ROW_BG) >= 3 && ratio('#b45309', WHITE) >= 3, 'High edge');
  // Filled vs outlined: the pills' fills differ strongly even though the hues are close.
  assert.ok(ratio('#b91c1c', WHITE) >= 4.5, 'Immediate fill vs High fill');
});
