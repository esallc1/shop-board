/* ============================================================
   require-user.test.js — the office-endpoint caller check.

   The rules that matter, each pinned here:
     • no token / malformed header      → null
     • junk or expired token            → null (Supabase says 401)
     • VALID session, but the auth user is not an active employee → null
       (this is the KiKi case: same auth.users, not our staff)
     • valid session + active employee  → { id, name, role }
     • is_test rows still pass          → staging's ZZ accounts must work
     • no SUPABASE_SERVICE_ROLE_KEY     → null (fails closed)
   Run: npm test   (node --test)
   ============================================================ */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireUser, bearerToken } from './_lib/require-user.js';

const UID = '11111111-2222-4333-8444-555555555555';
const STAFF = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Daiana Mendez', role: 'bookkeeping' };

const req = (auth) => ({ headers: auth === undefined ? {} : { authorization: auth } });

// A fake Supabase: `user` is the /auth/v1/user answer, `rows` the employees answer.
function fakeFetch({ user = null, rows = [], userStatus = 200, rowsStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: (init && init.headers) || {} });
    if (String(url).includes('/auth/v1/user')) {
      return { ok: userStatus < 400, status: userStatus, json: async () => user };
    }
    return { ok: rowsStatus < 400, status: rowsStatus, json: async () => rows };
  };
  fn.calls = calls;
  return fn;
}

let savedKey;
beforeEach(() => { savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'; });
afterEach(() => { if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey; });

test('bearerToken parses only a real Bearer header', () => {
  assert.equal(bearerToken(req('Bearer abc.def.ghi')), 'abc.def.ghi');
  assert.equal(bearerToken(req('bearer abc')), 'abc');          // case-insensitive scheme
  assert.equal(bearerToken(req('  Bearer   abc  ')), 'abc');
  assert.equal(bearerToken(req('Basic abc')), null);
  assert.equal(bearerToken(req('Bearer')), null);
  assert.equal(bearerToken(req('Bearer   ')), null);
  assert.equal(bearerToken(req()), null);
  assert.equal(bearerToken({}), null);
  assert.equal(bearerToken(null), null);
});

test('no Authorization header → null, and Supabase is never called', async () => {
  const f = fakeFetch({ user: { id: UID }, rows: [STAFF] });
  assert.equal(await requireUser(req(), { fetchImpl: f }), null);
  assert.deepEqual(f.calls, []);
});

test('junk / expired token → null, and the employees lookup never runs', async () => {
  const f = fakeFetch({ userStatus: 401 });
  assert.equal(await requireUser(req('Bearer junk.token.here'), { fetchImpl: f }), null);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/auth\/v1\/user$/);
});

test('a valid session whose user is NOT an active employee → null (the KiKi case)', async () => {
  const f = fakeFetch({ user: { id: UID }, rows: [] });
  assert.equal(await requireUser(req('Bearer good.kiki.token'), { fetchImpl: f }), null);
  assert.equal(f.calls.length, 2);
  // The query itself must carry the active filter — a retired employee with an
  // auth user (Josh, on prod) must never come back.
  assert.match(f.calls[1].url, /active=is\.true/);
  assert.match(f.calls[1].url, new RegExp(`auth_user_id=eq\\.${UID}`));
});

test('valid session + active employee → the employee, nothing more', async () => {
  const f = fakeFetch({ user: { id: UID }, rows: [STAFF] });
  const e = await requireUser(req('Bearer good.token'), { fetchImpl: f });
  assert.deepEqual(e, { id: STAFF.id, name: 'Daiana Mendez', role: 'bookkeeping' });
  // The user check uses the CALLER's token; the roster read uses the service key.
  assert.equal(f.calls[0].headers.Authorization, 'Bearer good.token');
  assert.equal(f.calls[1].headers.apikey, 'test-service-key');
});

test('an is_test employee still passes — staging signs in with the ZZ accounts', async () => {
  const zz = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'ZZ Test Bookkeeping', role: 'bookkeeping' };
  const f = fakeFetch({ user: { id: UID }, rows: [zz] });
  assert.deepEqual(await requireUser(req('Bearer zz.token'), { fetchImpl: f }), zz);
  assert.ok(!/is_test/.test(f.calls[1].url), f.calls[1].url);
});

test('two matching employee rows → null (ambiguous resolves to nobody)', async () => {
  const f = fakeFetch({ user: { id: UID }, rows: [STAFF, STAFF] });
  assert.equal(await requireUser(req('Bearer good.token'), { fetchImpl: f }), null);
});

test('a session with no user id, or a failed roster read → null', async () => {
  assert.equal(await requireUser(req('Bearer t'), { fetchImpl: fakeFetch({ user: {} }) }), null);
  assert.equal(await requireUser(req('Bearer t'), { fetchImpl: fakeFetch({ user: { id: UID }, rowsStatus: 401 }) }), null);
  assert.equal(await requireUser(req('Bearer t'), { fetchImpl: fakeFetch({ user: { id: UID }, rows: { code: '42501' } }) }), null);
});

test('a thrown fetch → null, never an exception out of requireUser', async () => {
  const boom = async () => { throw new Error('network down'); };
  assert.equal(await requireUser(req('Bearer t'), { fetchImpl: boom }), null);
});

test('missing SUPABASE_SERVICE_ROLE_KEY fails CLOSED and calls nothing', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const f = fakeFetch({ user: { id: UID }, rows: [STAFF] });
  assert.equal(await requireUser(req('Bearer good.token'), { fetchImpl: f }), null);
  assert.deepEqual(f.calls, []);
});
