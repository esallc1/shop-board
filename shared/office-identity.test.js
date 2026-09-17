/* ============================================================
   office-identity.test.js — the phone branch never takes a credential from
   the URL. The ?u=phone&p=pin passthrough was deleted 2026-09-17; these tests
   fail if a URL reader comes back.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// office-identity.js ships as a CLASSIC browser <script> attaching to `window`.
// Load the real file text into a vm sandbox with a fake window + localStorage.
const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, 'office-identity.js'), 'utf8');
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const window = {
  location: { search: '', pathname: '/advisor-board.html', hostname: 'localhost' },
  history: { replaceState() { throw new Error('URL must not be rewritten'); } },
};
const sandbox = { window, localStorage, URLSearchParams, console };
vm.createContext(sandbox);
new vm.Script(code).runInContext(sandbox);
const { resolvePhone, resolve } = window.OfficeIdentity;

const EMP = { id: '11111111-2222-4333-8444-555555555555', name: 'ZZ Test', role: 'advisor', photo_url: null };

// Records every query; returns `rows` for list reads and `rows[0]` for single reads.
function mockDb(rows) {
  const calls = [];
  const q = {
    select(c) { calls.push(['select', c]); return q; },
    eq(k, v) { calls.push(['eq', k, v]); return q; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
    maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
  };
  return {
    calls,
    from(t) { calls.push(['from', t]); return q; },
    auth: { getSession: async () => ({ data: { session: null } }), signOut: async () => {} },
  };
}

test('?u=&p= in the URL is IGNORED: no employees query, no persist, null', async () => {
  store.clear();
  window.location.search = '?u=5550009999&p=0000';
  const db = mockDb([EMP]);
  const row = await resolvePhone({ db, sessionPhoneKey: 'advisorBoardPhone' });
  assert.equal(row, null);
  assert.deepEqual(db.calls, []);
  assert.equal(localStorage.getItem('advisorBoardPhone'), null);
});

test('no query ever filters on pin, even via resolve() with a URL credential', async () => {
  store.clear();
  window.location.search = '?u=5550009999&p=0000';
  const db = mockDb([EMP]);
  assert.equal(await resolve({ db, sessionPhoneKey: 'advisorBoardPhone' }), null);
  assert.ok(!db.calls.some((c) => c[0] === 'eq' && c[1] === 'pin'), JSON.stringify(db.calls));
});

test('a persisted UUID session still resolves (by id, not pin)', async () => {
  store.clear();
  window.location.search = '';
  localStorage.setItem('advisorBoardPhone', EMP.id);
  const db = mockDb([EMP]);
  const row = await resolvePhone({ db, sessionPhoneKey: 'advisorBoardPhone' });
  assert.deepEqual(row, EMP);
  assert.ok(db.calls.some((c) => c[0] === 'eq' && c[1] === 'id' && c[2] === EMP.id));
});
