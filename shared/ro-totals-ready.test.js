/* ============================================================
   ro-totals-ready.test.js — the "wait for THE RO calculator" gate.
   Run: npm test   (node --test)

   ro-totals-ready.js is a CLASSIC script (a board's main <script> needs it
   synchronously), so it can't be imported — load the real file into a vm
   sandbox with a fake window/document, as supabase-config.test.js does.

   Locks: resolves with RoTotals when it's already there; waits (does NOT
   resolve early) while the page is still loading; resolves with the
   calculator if it arrived by DOMContentLoaded, with null if it didn't; and
   a late include after DOMContentLoaded answers at once.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, 'ro-totals-ready.js'), 'utf8');

function page(readyState = 'loading') {
  const listeners = {};
  const document = {
    readyState,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const win = { document };
  win.window = win;
  vm.createContext(win);
  new vm.Script(code).runInContext(win);
  const fireDCL = () => { document.readyState = 'complete'; (listeners.DOMContentLoaded || []).forEach(fn => fn()); };
  return { win, fireDCL };
}
const tick = () => new Promise(r => setImmediate(r));

test('already loaded → resolves with the calculator', async () => {
  const { win } = page();
  const RT = { computeRoTotals() {} };
  win.RoTotals = RT;
  assert.equal(await win.cdRoTotalsReady(), RT);
});

test('still parsing → waits; the module arriving by DOMContentLoaded resolves it', async () => {
  const { win, fireDCL } = page();
  let got = 'pending';
  win.cdRoTotalsReady().then(v => { got = v; });
  await tick();
  assert.equal(got, 'pending', 'must not resolve before the modules have run');
  const RT = { computeRoTotals() {} };
  win.RoTotals = RT;          // module scripts run…
  fireDCL();                  // …then DOMContentLoaded
  await tick();
  assert.equal(got, RT);
});

test('every waiter gets the answer', async () => {
  const { win, fireDCL } = page();
  const a = win.cdRoTotalsReady(), b = win.cdRoTotalsReady();
  const RT = {}; win.RoTotals = RT; fireDCL();
  assert.equal(await a, RT);
  assert.equal(await b, RT);
});

test('module failed (missing at DOMContentLoaded) → null, never a guess', async () => {
  const { win, fireDCL } = page();
  const p = win.cdRoTotalsReady();
  fireDCL();
  assert.equal(await p, null);
  assert.equal(await win.cdRoTotalsReady(), null);   // later callers too
});

test('late include after DOMContentLoaded answers at once', async () => {
  const loaded = page('complete');
  assert.equal(await loaded.win.cdRoTotalsReady(), null);
  const ok = page('complete');
  const RT = {}; ok.win.RoTotals = RT;
  assert.equal(await ok.win.cdRoTotalsReady(), RT);
});

test("readyState 'interactive' still waits (modules haven't run yet)", async () => {
  const { win, fireDCL } = page('interactive');
  let got = 'pending';
  win.cdRoTotalsReady().then(v => { got = v; });
  await tick();
  assert.equal(got, 'pending');
  fireDCL();
  await tick();
  assert.equal(got, null);
});

test('exposes the one failure message', () => {
  const { win } = page();
  assert.match(win.cdRoTotalsMissingText, /card fee/);
  assert.match(win.cdRoTotalsMissingText, /Reload/);
});
