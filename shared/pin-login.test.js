/* ============================================================
   pin-login.test.js — the tech PIN is checked in the database, never in the
   browser. Covers shared/pin-login.js (the RPC wrapper), a static guard that no
   page or shared script reads/writes the `pin` column again, and the shape of
   the Phase-2 migrations that the wrapper depends on.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

// pin-login.js ships as a CLASSIC browser <script> attaching to `window`.
const window = {};
const sandbox = { window, console: { error() {} } };
vm.createContext(sandbox);
new vm.Script(read('shared', 'pin-login.js')).runInContext(sandbox);
const { login } = window.PinLogin;

function mockDb(result) {
  const calls = [];
  return {
    calls,
    rpc(fn, args) { calls.push(['rpc', fn, args]); return typeof result === 'function' ? result() : Promise.resolve(result); },
    from(t) { calls.push(['from', t]); throw new Error('login must not query a table'); },
  };
}

const ROW = { name: 'ZZ Test Tech', phone: '5550100001', role: 'tech' };

test('calls login_with_pin with p_phone/p_pin and never touches a table', async () => {
  const db = mockDb({ data: [ROW], error: null });
  await login(db, '5550100001', '1234');
  // JSON round-trip: the args object is built inside the vm realm (different prototype).
  assert.deepEqual(JSON.parse(JSON.stringify(db.calls)), [['rpc', 'login_with_pin', { p_phone: '5550100001', p_pin: '1234' }]]);
});

test('one row → the historical findEmployee shape, id = phone', async () => {
  const tech = await login(mockDb({ data: [ROW], error: null }), '5550100001', '1234');
  assert.deepEqual({ ...tech }, { id: '5550100001', name: 'ZZ Test Tech', phone: '5550100001', role: 'tech' });
});

test('a single-object payload is accepted too', async () => {
  const tech = await login(mockDb({ data: ROW, error: null }), '5550100001', '1234');
  assert.equal(tech.id, '5550100001');
});

test('zero rows (any failure, incl. locked) → null', async () => {
  assert.equal(await login(mockDb({ data: [], error: null }), '5550100001', '0000'), null);
  assert.equal(await login(mockDb({ data: null, error: null }), '5550100001', '0000'), null);
});

test('more than one row → null (never pick one)', async () => {
  assert.equal(await login(mockDb({ data: [ROW, ROW], error: null }), '5550100001', '1234'), null);
});

test('rpc error, rejection, or no db → null', async () => {
  assert.equal(await login(mockDb({ data: null, error: { message: 'boom' } }), '1', '2'), null);
  assert.equal(await login(mockDb(() => Promise.reject(new Error('offline'))), '1', '2'), null);
  assert.equal(await login(null, '1', '2'), null);
});

test('the result carries nothing beyond id/name/phone/role', async () => {
  const tech = await login(mockDb({ data: [{ ...ROW, pin_hash: 'x', employee_id: 'y' }], error: null }), '5550100001', '1234');
  assert.deepEqual(Object.keys(tech).sort(), ['id', 'name', 'phone', 'role']);
});

// ── Static guard: nothing served reads or writes employees.pin again ─────────
const served = [
  ...readdirSync(root).filter((f) => f.endsWith('.html')),
  ...readdirSync(join(root, 'shared')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => 'shared/' + f),
  ...readdirSync(join(root, 'api')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => 'api/' + f),
];

test('no served file filters on, selects, or writes a pin column', () => {
  const bad = [];
  for (const f of served) {
    const src = read(f);
    if (/\.eq\(\s*['"]pin['"]/.test(src)) bad.push(f + ': .eq(pin)');
    if (/\.select\(\s*['"][^'"]*\bpin\b/.test(src)) bad.push(f + ': select(...pin...)');
    if (/\bpin\s*[,}]/.test(src) && /\.(insert|update|upsert)\(/.test(src) && /payload\s*=\s*\{[^}]*\bpin\b/.test(src)) bad.push(f + ': pin in a write payload');
    if (/\.pin\b/.test(src) && /\bemp\.pin\b|\bd\.pin\b|\brow\.pin\b/.test(src)) bad.push(f + ': reads <row>.pin');
  }
  assert.deepEqual(bad, []);
});

test('gm-board Employee form has no PIN input and does not require one', () => {
  const gm = read('gm-board.html');
  assert.ok(!/empPinInput/.test(gm));
  assert.ok(!/phone, PIN, and role/.test(gm));
});

test('my-numbers loads pin-login.js and logs in through it', () => {
  const mn = read('my-numbers.html');
  assert.match(mn, /<script src="shared\/pin-login\.js"><\/script>/);
  assert.match(mn, /PinLogin\.login\(db, phone, pin\)/);
});

// ── Migration shape the wrapper depends on ───────────────────────────────────
const M1 = read('migrations', '20260917_pin_off_public_M1_employee_secrets.sql');
const M2 = read('migrations', '20260917_pin_off_public_M2_drop_pin.sql');
const sqlOnly = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('M1: secrets table locked (RLS on, no policies, grants revoked)', () => {
  const s = sqlOnly(M1);
  assert.match(s, /alter table public\.employee_secrets enable row level security/);
  assert.match(s, /revoke all on table public\.employee_secrets from public, anon, authenticated/);
  assert.ok(!/create policy/i.test(s));
  assert.ok(!/grant[^;]*employee_secrets/i.test(s));
});

test('M1: login_with_pin is definer, pinned search_path, never returns the hash', () => {
  const s = sqlOnly(M1);
  assert.match(s, /security definer/);
  assert.match(s, /set search_path = public, extensions, pg_temp/);
  const ret = s.match(/returns table \(([^)]*)\)/);
  assert.ok(ret);
  assert.equal(ret[1].replace(/\s+/g, ' ').trim(), 'name text, phone text, role text');
  assert.match(s, /revoke all on function public\.login_with_pin\(text, text\) from public;/);
  assert.match(s, /grant execute on function public\.login_with_pin\(text, text\) to anon, authenticated;/);
  assert.match(s, /interval '15 minutes'/);
  assert.match(s, />= 5/);
});

test('M1: ZZ Test Tech is never backfilled on PROD', () => {
  assert.match(sqlOnly(M1), /e\.name = 'ZZ Test Tech'\s+and \(select env from public\.app_env limit 1\) not like 'PROD%'/);
});

test('M2: view list has no pin; the column drop has no CASCADE', () => {
  const s = sqlOnly(M2);
  const view = s.match(/create view public\.employees_visible[\s\S]*?from public\.employees/);
  assert.ok(view);
  assert.ok(!/\bpin\b/.test(view[0]));
  assert.match(s, /alter table public\.employees drop column pin;/);
  assert.ok(!/cascade/i.test(s));
});
