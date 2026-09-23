/* ============================================================
   advisor-views.test.js — the advisor sidebar cleanup (Front Desk redesign).
   Run: npm test   (node --test)

   Locks: Parts, Payments and Customer Log are gone from the advisor board —
   nav entry, view, and the JS that fed them — while Capture Invoice and every
   other tab stay; the RO's own Payments section is untouched; and a refresh
   with a REMOVED tab saved lands on its replacement (never a blank view) and
   clears the stale key.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const board = readFileSync(join(here, '..', 'advisor-board.html'), 'utf8');

function loadHelper() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  new vm.Script(readFileSync(join(here, 'advisor-views.js'), 'utf8')).runInContext(sandbox);
  return sandbox.window.cdResolveSavedView;
}

const LIVE = [...board.matchAll(/class="sidebar-item[^"]*" data-view="([^"]+)"/g)].map((m) => m[1]);

test('the three removed tabs are gone from the advisor sidebar — nav, view and feeding JS', () => {
  for (const key of ['parts', 'payments', 'customer-log']) {
    assert.ok(!LIVE.includes(key), `nav entry ${key} still there`);
    assert.ok(!board.includes(`id="view-${key}"`), `view-${key} still there`);
  }
  for (const gone of ['loadAndRenderParts', 'orderPartModal', 'openOrderPartModal', 'function addNote()',
    'new-note-input', 'loadPayLedger', 'cdPayLedgerBody', "data-view=\"payments\"", 'advisor-board-parts-live']) {
    assert.ok(!board.includes(gone), `${gone} still in advisor-board.html`);
  }
});

test('Capture Invoice and every other tab stay', () => {
  for (const key of ['cdros', 'techboard', 'approval', 'customer', 'capture', 'desk', 'todo', 'teamchat']) {
    assert.ok(LIVE.includes(key), `${key} missing from the sidebar`);
    assert.ok(board.includes(`id="view-${key}"`), `view-${key} missing`);
  }
  assert.match(board, /data-view="capture" data-label="Capture Invoice"/);
});

test('the RO detail keeps its own Payments section (record + list)', () => {
  for (const kept of ['id="cdPayRecordBtn"', 'async function loadPayments()', 'function renderPayments()', 'async function recordPayment()']) {
    assert.ok(board.includes(kept), `${kept} missing`);
  }
});

test('the Desk call log keeps the shared .log-time rule', () => {
  assert.match(board, /\.log-time \{\s*font-size: 0\.7rem; color: var\(--muted\);\s*font-family: 'Courier New', monospace;/);
});

test('saved REMOVED tab → its replacement, and the stale key is cleared', () => {
  const resolve = loadHelper();
  assert.deepEqual({ ...resolve('payments', LIVE) }, { view: 'cdros', clear: true });
  assert.deepEqual({ ...resolve('parts', LIVE) }, { view: 'cdros', clear: true });
  assert.deepEqual({ ...resolve('customer-log', LIVE) }, { view: 'desk', clear: true });
});

test('saved live tab → reopened; unknown → nothing (board default), key cleared; nothing saved → nothing', () => {
  const resolve = loadHelper();
  assert.deepEqual({ ...resolve('capture', LIVE) }, { view: 'capture', clear: false });
  assert.deepEqual({ ...resolve('desk', LIVE) }, { view: 'desk', clear: false });
  assert.deepEqual({ ...resolve('no-such-tab', LIVE) }, { view: null, clear: true });
  assert.deepEqual({ ...resolve(null, LIVE) }, { view: null, clear: false });
  assert.deepEqual({ ...resolve('', LIVE) }, { view: null, clear: false });
  // a replacement that isn't on this board → no click, key still cleared
  assert.deepEqual({ ...resolve('payments', ['approval']) }, { view: null, clear: true });
});

test('the board loads the helper before its inline script and restores through it', () => {
  const helperAt = board.indexOf('<script src="shared/advisor-views.js"></script>');
  const mainAt = board.indexOf('const ACTIVE_VIEW_KEY');
  assert.ok(helperAt > 0 && helperAt < mainAt, 'helper must load before the board script');
  assert.match(board, /window\.cdResolveSavedView\(saved, keys\)/);
  assert.match(board, /if \(r\.clear\) \{ try \{ sessionStorage\.removeItem\(ACTIVE_VIEW_KEY\); \} catch \(e\) \{\} \}/);
});

/* ── My Commission — DISABLED 2026-09-23 (Cris: no commission pay plan) ─────── */
test('My Commission never shows on the advisor board, whatever the stored setting says', () => {
  assert.match(board, /const ADVISOR_COMMISSION_ENABLED = false;/);
  const fn = board.slice(board.indexOf('function myCommissionOn()'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  // the kill switch is checked FIRST, before the setting is even read
  assert.ok(body.indexOf('if (!ADVISOR_COMMISSION_ENABLED) return false;') !== -1);
  assert.ok(body.indexOf('if (!ADVISOR_COMMISSION_ENABLED) return false;') < body.indexOf('feature_advisor_commission'));
  // refreshMyCommissionNav shows the tab ONLY through myCommissionOn(); the markup starts hidden
  assert.match(board, /const on = myCommissionOn\(\);\s*const nav = document\.getElementById\('nav-mycommission'\);\s*if \(nav\) nav\.style\.display = on \? '' : 'none';/);
  assert.match(board, /id="nav-mycommission" style="display:none"/);
  // and it is not among the live advisor tabs a restore may land on
  assert.deepEqual({ ...loadHelper()('mycommission', LIVE) }, { view: 'cdros', clear: true });
});

test('the Advisor Commission on/off switch is gone from Settings → Features (the column + readers stay)', () => {
  const bs = readFileSync(join(here, 'board-settings.js'), 'utf8');
  const reg = bs.slice(bs.indexOf('const FEATURE_FLAGS = ['), bs.indexOf('];', bs.indexOf('const FEATURE_FLAGS = [')));
  const live = reg.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(live, /key: 'advisor_commission'/);
  assert.doesNotMatch(live, /column: 'feature_advisor_commission'/);
  for (const k of ['book_hours', 'packages', 'bk_ro_detail']) assert.match(live, new RegExp(`key: '${k}'`), k + ' switch lost');
  assert.match(bs, /feature_advisor_commission: !!shopSettingsRow\.feature_advisor_commission/);   // still read (owner / bookkeeping)
});
