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
function load() {
  const warnings = [];
  const calls = [];
  const state = { impl: async () => ({ ok: true, status: 200 }) };
  const window = {
    fetch: async (url, opts) => { calls.push({ url, opts }); return state.impl(url, opts); },
  };
  const sandbox = { window, console: { warn: (...a) => warnings.push(a.join(' ')), error() {} } };
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);
  return { authFetch: window.cdAuthFetch, warnings, calls, state };
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
  const GATED = ['announcement', 'change-request', 'desk-appointment', 'recording-links', 'recording-assign'];
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
