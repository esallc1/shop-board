/* ============================================================
   floor-clear.test.js — closing an RO takes its car off the shop floor.
   Run: npm test   (node --test)

   Locks (Kevin's "Tech Board shows jobs that already left", Aug 6/13/26):
   1. removeCarFromFloor: parking + pickup rows DELETED by po; a lift bay is
      CLEARED to EMPTY_LIFT and NEVER deleted; idempotent; stops at first error.
   2. prepareClose: ask → remove floor → ok. Cancel touches nothing; a floor
      failure says "don't write the status"; Off lot's pre-confirm isn't asked twice.
   3. The board has ONE close path: setStage('closed') removes the floor BEFORE
      the status write; Off lot calls that step (not its own removal); the job
      category archive still reads the RO row. Static guard, same approach as
      cust-cache-guard.test.js.
   4. The one-time cleanup SQL: the 14 POs only, current status (not closed_at),
      backup first, lifts cleared to EMPTY_LIFT (never deleted), guards, undo.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EMPTY_LIFT, CLOSE_CONFIRM_TEXT, removeCarFromFloor, prepareClose } from './floor-clear.js';

const here = dirname(fileURLToPath(import.meta.url));
const BOARD = readFileSync(join(here, '..', 'advisor-board.html'), 'utf8');

// supabase-js-shaped fake over three in-memory tables. Records every call as
// { table, op, payload?, filter } so a test can assert exactly what was touched.
function fakeDb(tables, { failOn } = {}) {
  const calls = [];
  const T = JSON.parse(JSON.stringify(tables));
  function qb(table) {
    const st = { table, op: 'select', payload: null, filter: null };
    const b = {
      select() { return b; },
      delete() { st.op = 'delete'; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      eq(col, val) { st.filter = [col, val]; return b; },
      then(resolve) {
        calls.push({ ...st });
        if (failOn && failOn(st)) return resolve({ data: null, error: { message: 'boom ' + table } });
        const rows = T[table] || [];
        const hit = rows.filter((r) => st.filter && String(r[st.filter[0]]) === String(st.filter[1]));
        if (st.op === 'delete') { T[table] = rows.filter((r) => !hit.includes(r)); return resolve({ data: hit.map((r) => ({ id: r.id })), error: null }); }
        if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.payload)); return resolve({ data: null, error: null }); }
        return resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
      },
    };
    return b;
  }
  return { calls, tables: T, from: (t) => qb(t) };
}

const FLOOR = () => ({
  shopboard_parking: [{ id: 'p1', po: '6030', vehicle: 'Ford F-150' }, { id: 'p2', po: '6073', vehicle: 'Other car' }],
  shopboard_pickup: [{ id: 'k1', po: '6017', vehicle: 'Colorado' }],
  shopboard_lifts: [1, 2, 3, 4, 5, 6].map((id) => ({ id, po: id === 3 ? '6029' : '', vehicle: id === 3 ? 'Altima' : '', status: id === 3 ? 'waiting-part' : 'empty', assigned_tech: id === 3 ? 'Jay' : '' })),
});

// ── 1. removeCarFromFloor ───────────────────────────────────
test('EMPTY_LIFT is the v1 empty-bay shape, unchanged and frozen', () => {
  assert.deepEqual({ ...EMPTY_LIFT }, {
    po: '', vehicle: '', customer: '', work: '', status: 'empty', notes: '',
    arrival_date: null, assigned_tech: '', tech_status: 'available',
    tech_notes: '', job_category: '', warranty: false,
  });
  assert.ok(Object.isFrozen(EMPTY_LIFT));
});

test('a car on the LOT is deleted by po; other cars are untouched', async () => {
  const db = fakeDb(FLOOR());
  const r = await removeCarFromFloor(db, '6030');
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed, { parking: 1, pickup: 0, lifts: 0 });
  assert.deepEqual(db.tables.shopboard_parking.map((x) => x.po), ['6073']);
});

test('a car in PICKUP is deleted by po', async () => {
  const db = fakeDb(FLOOR());
  const r = await removeCarFromFloor(db, 6017);                    // number po is fine
  assert.deepEqual(r.removed, { parking: 0, pickup: 1, lifts: 0 });
  assert.equal(db.tables.shopboard_pickup.length, 0);
});

test('a car on a LIFT: the bay is CLEARED to EMPTY_LIFT, the row is never deleted', async () => {
  const db = fakeDb(FLOOR());
  const r = await removeCarFromFloor(db, '6029');
  assert.deepEqual(r.removed, { parking: 0, pickup: 0, lifts: 1 });
  assert.equal(db.tables.shopboard_lifts.length, 6, 'still six bays');
  const bay3 = db.tables.shopboard_lifts.find((l) => l.id === 3);
  assert.equal(bay3.po, ''); assert.equal(bay3.vehicle, ''); assert.equal(bay3.status, 'empty'); assert.equal(bay3.assigned_tech, '');
  assert.equal(db.calls.some((c) => c.table === 'shopboard_lifts' && c.op === 'delete'), false, 'no delete ever issued to lifts');
  const upd = db.calls.filter((c) => c.table === 'shopboard_lifts' && c.op === 'update');
  assert.deepEqual(upd.map((c) => c.filter), [['id', 3]], 'cleared by bay id, not by po');
  assert.deepEqual(upd[0].payload, { ...EMPTY_LIFT });
});

test('idempotent: a po that is not on the floor is a no-op success; a blank po touches nothing', async () => {
  const db = fakeDb(FLOOR());
  assert.deepEqual(await removeCarFromFloor(db, '9999'), { ok: true, removed: { parking: 0, pickup: 0, lifts: 0 } });
  const db2 = fakeDb(FLOOR());
  assert.deepEqual(await removeCarFromFloor(db2, ''), { ok: true, removed: { parking: 0, pickup: 0, lifts: 0 } });
  assert.equal(db2.calls.length, 0, 'a blank po never reaches the database (would match every empty lift)');
});

test('stops at the first error and reports it', async () => {
  const db = fakeDb(FLOOR(), { failOn: (st) => st.table === 'shopboard_pickup' });
  const r = await removeCarFromFloor(db, '6017');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /boom shopboard_pickup/);
  assert.equal(db.calls.some((c) => c.table === 'shopboard_lifts'), false, 'nothing after the failure');
});

// ── 2. prepareClose: ask → floor → ok ───────────────────────
test('prepareClose: confirm yes → removes the floor → ok (the caller may now write the status)', async () => {
  const order = [];
  const r = await prepareClose({
    confirm: () => { order.push('confirm'); return true; },
    removeFloor: async () => { order.push('floor'); return { ok: true, removed: { parking: 1, pickup: 0, lifts: 0 } }; },
  });
  assert.deepEqual(order, ['confirm', 'floor']);
  assert.equal(r.ok, true);
});

test('prepareClose: CANCEL does nothing — the floor is never touched', async () => {
  let floorCalls = 0;
  const r = await prepareClose({ confirm: () => false, removeFloor: async () => { floorCalls++; return { ok: true }; } });
  assert.deepEqual(r, { ok: false, reason: 'cancelled' });
  assert.equal(floorCalls, 0);
});

test('prepareClose: no confirm function and not pre-confirmed → treated as cancel', async () => {
  let floorCalls = 0;
  const r = await prepareClose({ removeFloor: async () => { floorCalls++; return { ok: true }; } });
  assert.equal(r.reason, 'cancelled');
  assert.equal(floorCalls, 0);
});

test('prepareClose: Off lot (alreadyConfirmed) is not asked twice', async () => {
  let asked = 0;
  const r = await prepareClose({ alreadyConfirmed: true, confirm: () => { asked++; return false; }, removeFloor: async () => ({ ok: true }) });
  assert.equal(asked, 0);
  assert.equal(r.ok, true);
});

test('prepareClose: a floor failure (returned or thrown) → not ok, reason "floor" — the status must not be written', async () => {
  const e1 = { message: 'rls' };
  assert.deepEqual(await prepareClose({ alreadyConfirmed: true, removeFloor: async () => ({ ok: false, error: e1 }) }), { ok: false, reason: 'floor', error: e1 });
  const thrown = await prepareClose({ alreadyConfirmed: true, removeFloor: async () => { throw new Error('net'); } });
  assert.equal(thrown.reason, 'floor');
  assert.match(thrown.error.message, /net/);
});

test('the confirm text says the car leaves the floor', () => {
  assert.equal(CLOSE_CONFIRM_TEXT, 'This also removes the car from the shop floor.');
});

// ── 3. the board: ONE close path ────────────────────────────
function fnBody(name) {
  const start = BOARD.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in advisor-board.html');
  const rest = BOARD.slice(start + 10);
  const next = rest.search(/\n    (async )?function /);
  return BOARD.slice(start, start + 10 + (next < 0 ? rest.length : next));
}

test('board: setStage removes the floor AFTER the comeback + book-hours checks and BEFORE the status write', () => {
  const body = fnBody('setStage');
  const comeback = body.indexOf('validateComebackClose');
  const bookHours = body.indexOf('bookHoursGateForAdvance');
  const floor = body.indexOf('FC.prepareClose(');
  const optimistic = body.indexOf('currentRo.status = next;');
  const write = body.indexOf(".update({ status: next })");
  const archive = body.indexOf('archiveToCompletedJobs(');
  for (const [n, i] of Object.entries({ comeback, bookHours, floor, optimistic, write, archive })) assert.ok(i > 0, n + ' not found');
  assert.ok(comeback < floor && bookHours < floor, 'checks first');
  assert.ok(floor < optimistic && floor < write, 'floor BEFORE the status is touched');
  assert.ok(write < archive, 'archive after the status write');
  assert.match(body, /if \(next === 'closed'\) \{\s*\n\s*const po = currentRo\.po \|\| String\(currentRo\.ro_number\);/);
  assert.match(body, /alreadyConfirmed: !!opts\.floorConfirmed/);
  assert.match(body, /removeFloor: \(\) => removeCarFromFloor\(po\)/);
  assert.match(body, /confirm: \(\) => confirm\(`Close RO #\$\{po\}\?\\n\\n\$\{FC\.CLOSE_CONFIRM_TEXT\}`\)/);
});

test('board: a cancelled or failed floor step returns before the status is touched', () => {
  const body = fnBody('setStage');
  const block = body.slice(body.indexOf('FC.prepareClose('), body.indexOf('currentRo.status = next;'));
  assert.match(block, /if \(!pre\.ok\) \{[\s\S]*return;\s*\n\s*\}/);
  assert.doesNotMatch(block, /\.update\(/, 'no write inside the floor step');
});

test('board: Off lot uses the one close step — no removal of its own', () => {
  const body = fnBody('offLotCard');
  assert.doesNotMatch(body, /removeCarFromFloor\(/);
  assert.match(body, /await setStage\('closed', \{ floorConfirmed: true \}\)/);
  assert.ok(body.indexOf('confirm(') < body.indexOf('loadRoContext('), 'asks before loading');
  assert.ok(body.indexOf('loadRoContext(') < body.indexOf("setStage('closed'"), 're-reads the RO, then closes');
});

test('board: removeCarFromFloor is called ONLY from setStage, and delegates to shared/floor-clear.js', () => {
  const calls = [...BOARD.matchAll(/(?<!function |FC\.)removeCarFromFloor\(/g)].length;
  assert.equal(calls, 1, 'one call site (setStage)');
  assert.match(fnBody('removeCarFromFloor'), /FC\.removeCarFromFloor\(db, po\)/);
  assert.doesNotMatch(BOARD, /const EMPTY_LIFT\s*=/, 'no second copy of the empty-bay shape');
  assert.match(BOARD, /import \* as FloorClear from '\.\/shared\/floor-clear\.js';/);
});

// ── 4. the one-time cleanup SQL (hand-run, sandbox then prod) ─
const MIG = join(here, '..', 'migrations');
const CLEANUP = readdirSync(MIG).filter((f) => /_floor_ghosts_cleanup_(SANDBOX|PROD)\.sql$/.test(f));
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');   // executable SQL only

test('cleanup SQL: exactly two files, SANDBOX + PROD, each guarded the right way round', () => {
  assert.deepEqual(CLEANUP.map((f) => f.match(/_(SANDBOX|PROD)\.sql$/)[1]).sort(), ['PROD', 'SANDBOX']);
  for (const f of CLEANUP) {
    const sql = readFileSync(join(MIG, f), 'utf8');
    if (f.includes('SANDBOX')) {
      assert.match(sql, /if v like 'PROD%' then/);
      assert.match(sql, /\(select env from public\.app_env limit 1\) not like 'PROD%'/);
    } else {
      assert.match(sql, /if v not like 'PROD%' then/);
      assert.match(sql, /\(select env from public\.app_env limit 1\) like 'PROD%'/);
    }
    assert.match(sql, /app_env HAS NO ROW/);
  }
});

test('cleanup SQL: the 14 listed POs exactly; declined #6054/#6072 and paid-not-closed #6074 are NOT touched', () => {
  const want = ['6017', '6027', '6029', '6030', '6033', '6040', '6043', '6053', '6056', '6051', '6045', '6066', '6071', '6069'];
  for (const f of CLEANUP) {
    const c = code(readFileSync(join(MIG, f), 'utf8'));
    const list = c.match(/listed\(po\) as \(\s*values([\s\S]*?)\), floor_rows/)[1];
    assert.deepEqual([...list.matchAll(/'(\d+)'/g)].map((m) => m[1]), want, f);
    for (const out of ['6054', '6072', '6074']) assert.doesNotMatch(c, new RegExp(`'${out}'`), f + ' must leave ' + out);
  }
});

test('cleanup SQL: re-checks the RO\'s CURRENT status (every RO for the po closed) — never closed_at', () => {
  for (const f of CLEANUP) {
    const c = code(readFileSync(join(MIG, f), 'utf8'));
    assert.match(c, /string_agg\(distinct r\.status::text, ','\) from public\.repair_orders r where r\.po = l\.po/);
    assert.match(c, /where s\.statuses = 'closed'/);
    assert.doesNotMatch(c, /closed_at/, f + ': closed_at is kept on reopened ROs — must not be used');
    assert.match(c, /skipped_ro_not_closed/); assert.match(c, /skipped_no_ro/); assert.match(c, /not_on_floor/);
  }
});

test('cleanup SQL: backup first (RLS on, no policy), lot/pickup deleted, a lift CLEARED — never deleted', () => {
  for (const f of CLEANUP) {
    const sql = readFileSync(join(MIG, f), 'utf8'), c = code(sql);
    assert.match(c, /alter table public\.floor_ghost_backup_20260919 enable row level security;/);
    assert.doesNotMatch(c, /create policy/i);
    assert.ok(c.indexOf('insert into public.floor_ghost_backup_20260919') < c.indexOf('delete from public.shopboard_parking'), 'backup CTE first');
    assert.match(c, /delete from public\.shopboard_parking/);
    assert.match(c, /delete from public\.shopboard_pickup/);
    assert.doesNotMatch(c, /delete from public\.shopboard_lifts/i, f + ': a lift row is never deleted');
    assert.match(c, /update public\.shopboard_lifts\s+set /);
    assert.doesNotMatch(c, /\b(update|delete from|insert into)\s+public\.(repair_orders|completed_jobs)\b/i, f + ': RO + archive untouched');
    assert.match(sql, /UNDO \(not run\)/);
    assert.match(sql, /jsonb_populate_record\(null::public\.shopboard_parking/);
  }
});

test('cleanup SQL: the lift is cleared to EXACTLY the app\'s EMPTY_LIFT columns and values', () => {
  const sqlLit = (v) => (v === null ? 'null' : typeof v === 'boolean' ? String(v) : `'${v}'`);
  for (const f of CLEANUP) {
    const c = code(readFileSync(join(MIG, f), 'utf8'));
    const set = c.match(/update public\.shopboard_lifts\s+set ([\s\S]*?)\s+where id::text in/)[1];
    const pairs = Object.fromEntries(set.split(',').map((s) => s.trim().split(/\s*=\s*/)));
    assert.deepEqual(Object.keys(pairs).sort(), Object.keys(EMPTY_LIFT).sort(), f + ': same columns');
    for (const [k, v] of Object.entries(EMPTY_LIFT)) assert.equal(pairs[k], sqlLit(v), f + ': ' + k);
  }
});
