/* ============================================================
   auth-fetch.test.js — the client half: every office-endpoint call carries the
   signed-in session's token, and a refusal is never swallowed.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, 'auth-fetch.js'), 'utf8');

// The module attaches to `window` and fetches through it, exactly as a browser
// does (window.fetch === fetch there). `state.impl` lets a test swap the answer.
function load(document) {
  const warnings = [];
  const calls = [];
  const state = { impl: async () => ({ ok: true, status: 200 }) };
  const window = {
    fetch: async (url, opts) => { calls.push({ url, opts }); return state.impl(url, opts); },
    ...(document ? { document } : {}),
  };
  const sandbox = { window, console: { warn: (...a) => warnings.push(a.join(' ')), error() {} } };
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);
  return { authFetch: window.cdAuthFetch, window, warnings, calls, state };
}

const dbWith = (session) => ({ auth: { getSession: async () => ({ data: { session } }) } });

test('a signed-in session becomes an Authorization header', async () => {
  const { authFetch, calls } = load();
  await authFetch(dbWith({ access_token: 'tok-123' }), '/api/announcement', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok-123');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');  // caller headers kept
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, '{}');
});

test('no session → no header, a warning that names the cause, request still sent', async () => {
  const { authFetch, calls, warnings } = load();
  await authFetch(dbWith(null), '/api/change-request', { method: 'POST' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, undefined);
  assert.match(warnings.join('\n'), /no signed-in session .*\/api\/change-request/);
});

test('a getSession that throws does not stop the call', async () => {
  const { authFetch, calls, warnings } = load();
  const db = { auth: { getSession: async () => { throw new Error('storage blocked'); } } };
  await authFetch(db, '/api/recording-links', {});
  assert.equal(calls.length, 1);
  assert.match(warnings.join('\n'), /could not read the session/);
});

test('a rejected response is logged with its status and returned unchanged', async () => {
  const { authFetch, warnings, state } = load();
  state.impl = async () => ({ ok: false, status: 401 });
  const r = await authFetch(dbWith({ access_token: 't' }), '/api/desk-appointment', {});
  assert.equal(r.status, 401);                       // caller keeps its own handling
  assert.match(warnings.join('\n'), /\/api\/desk-appointment → HTTP 401/);
});

test('it never mutates the options object it was given', async () => {
  const { authFetch } = load();
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  await authFetch(dbWith({ access_token: 't' }), '/api/announcement', opts);
  assert.deepEqual(opts, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
});

// ── Static guard: no served page may call a gated endpoint with bare fetch ──
test('every gated-endpoint call site goes through cdAuthFetch', async () => {
  const { readdirSync } = await import('node:fs');
  const root = join(here, '..');
  const files = [
    ...readdirSync(root).filter((f) => f.endsWith('.html')),
    ...readdirSync(join(root, 'shared')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => 'shared/' + f),
  ];
  const GATED = ['announcement', 'change-request', 'desk-appointment', 'recording-links', 'recording-assign', 'extract-invoice', 'messenger'];
  const bad = [];
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const line of src.split('\n')) {
      if (!/\bfetch\(/.test(line) || /cdAuthFetch/.test(line)) continue;
      for (const ep of GATED) {
        if (line.includes("'/api/" + ep + "'") || (line.includes('fetch(endpoint') && src.includes("/api/" + ep))) {
          bad.push(f + ': ' + line.trim().slice(0, 80));
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});

/* ── The 401 message (Cris, 2026-09-23) ─────────────────────────────────── */
const EXACT = "Your CrisData sign-in isn't active on this page — log out and sign in again.";

// A tiny DOM: enough for cdShowSigninNotice (createElement / getElementById / body.appendChild).
function fakeDocument() {
  const byId = {};
  const mk = (tag) => {
    const el = { tagName: tag, style: {}, children: [], attrs: {}, listeners: {}, textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); if (c.id) byId[c.id] = c; return c; },
      addEventListener(t, f) { this.listeners[t] = f; } };
    Object.defineProperty(el, 'id', { get() { return this._id; }, set(v) { this._id = v; byId[v] = this; } });
    return el;
  };
  const body = mk('body');
  return { body, createElement: mk, getElementById: (id) => byId[id] || null, _byId: byId };
}

test('CD_SIGNIN_LOST is the exact sentence, and cdAuthErrorText uses it only for a 401', () => {
  const { window } = load();
  assert.equal(window.CD_SIGNIN_LOST, EXACT);
  assert.equal(window.cdAuthErrorText(401, 'Could not post: HTTP 401'), EXACT);
  assert.equal(window.cdAuthErrorText('401'), EXACT);
  assert.equal(window.cdAuthErrorText(500, 'Could not post: HTTP 500'), 'Could not post: HTTP 500');
  assert.equal(window.cdAuthErrorText(403), '');
});

test('a 401 shows ONE page-level notice with the exact sentence; dismiss hides it; a later 401 shows it again', async () => {
  const doc = fakeDocument();
  const { authFetch, state } = load(doc);
  state.impl = async () => ({ ok: false, status: 401 });
  await authFetch(dbWith(null), '/api/change-request', {});
  await authFetch(dbWith(null), '/api/recording-links', {});
  const el = doc._byId.cdSigninNotice;
  assert.ok(el, 'notice not shown');
  assert.equal(doc.body.children.length, 1, 'only one notice per page');
  assert.equal(el.children[0].textContent, '⚠ ' + EXACT);
  assert.equal(el.style.display, 'flex');
  el.children[1].listeners.click();
  assert.equal(el.style.display, 'none');
  await authFetch(dbWith(null), '/api/messenger', {});
  assert.equal(el.style.display, 'flex');
});

test('no notice for anything but a 401, and none without a DOM (never throws)', async () => {
  const doc = fakeDocument();
  const { authFetch, state } = load(doc);
  for (const status of [200, 400, 403, 409, 500, 502]) {
    state.impl = async () => ({ ok: status < 300, status });
    await authFetch(dbWith({ access_token: 't' }), '/api/messenger', {});
  }
  assert.equal(doc._byId.cdSigninNotice, undefined);
  const bare = load();
  bare.state.impl = async () => ({ ok: false, status: 401 });
  const r = await bare.authFetch(dbWith(null), '/api/change-request', {});
  assert.equal(r.status, 401);
  assert.equal(bare.window.cdShowSigninNotice(), false);
});

test('every screen that prints its own error for a gated call uses cdAuthErrorText', () => {
  const root = join(here, '..');
  for (const f of ['shared/report-change.js', 'shared/announcement-banner.js', 'advisor-board.html', 'bookkeeping-board.html']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.match(src, /cdAuthErrorText\(/, f + ' does not use cdAuthErrorText');
  }
  // every board that calls cdAuthFetch loads shared/auth-fetch.js
  for (const f of ['advisor-board.html', 'gm-board.html', 'owner-board.html', 'bookkeeping-board.html']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.match(src, /<script src="shared\/auth-fetch\.js"><\/script>/, f);
  }
  // invoice auto-detect no longer builds its own header
  const bk = readFileSync(join(root, 'bookkeeping-board.html'), 'utf8');
  assert.match(bk, /cdAuthFetch\(db, '\/api\/extract-invoice'/);
  assert.doesNotMatch(bk, /headers\.Authorization = 'Bearer '/);
});

test('the Messenger tray says the same sentence (its pure module keeps a test-locked copy)', async () => {
  const { window } = load();
  const logic = await import('./messenger-tray-logic.js');
  assert.equal(logic.SIGNIN_LOST_TEXT, window.CD_SIGNIN_LOST);
  assert.equal(logic.replyError(401, { error: 'unauthorized' }).message, EXACT);
});
