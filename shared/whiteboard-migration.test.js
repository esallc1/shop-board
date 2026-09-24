/* ============================================================
   whiteboard-migration.test.js — the Whiteboard tables' security posture.
   Run: npm test   (node --test)

   Static checks on migrations/20260924_whiteboard_{SANDBOX,PROD}.sql (hand-run
   SQL — nothing here touches a database). Locks:
     • the two files are the same apart from the header + the inverted guard;
     • guarded, one transaction, needs is_staff();
     • anon / authenticated get every privilege REVOKED; only authenticated gets
       SELECT back — never insert/update/delete/all;
     • the only policies are SELECT, to authenticated, using is_staff();
     • both tables join supabase_realtime; no DELETE anywhere (soft erase only).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SANDBOX = readFileSync(join(DIR, '20260924_whiteboard_SANDBOX.sql'), 'utf8');
const PROD = readFileSync(join(DIR, '20260924_whiteboard_PROD.sql'), 'utf8');
const TABLES = 'public.whiteboard_items, public.whiteboard_pickup_calls';

// SQL with `--` comments removed, whitespace collapsed, lowercased — the verify
// block's commented-out statements can never satisfy (or fail) a check.
function code(sql) {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/\s+/g, ' ').toLowerCase();
}

test('SANDBOX and PROD differ only in the header lines and the guard', () => {
  const a = SANDBOX.split('\n');
  const b = PROD.split('\n');
  assert.equal(a.length, b.length);
  const diffs = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  assert.equal(diffs.length, 3, 'expected exactly 3 differing lines');
  for (const i of diffs) {
    assert.ok(/^--/.test(a[i]) || /raise exception 'WRONG PROJECT/.test(a[i] + b[i]), `unexpected diff at line ${i + 1}`);
  }
  assert.match(SANDBOX, /if v like 'PROD%' then raise exception 'WRONG PROJECT/);
  assert.match(PROD, /if v not like 'PROD%' then raise exception 'WRONG PROJECT/);
});

for (const [name, sql] of Object.entries({ SANDBOX, PROD })) {
  const c = code(sql);

  test(`${name}: guarded, one transaction, needs is_staff()`, () => {
    assert.match(c, /^ ?begin; do \$\$ declare v text; begin select env into v from public\.app_env/);
    assert.match(c, /app_env has no row/);
    assert.match(c, /to_regprocedure\('public\.is_staff\(\)'\) is null then raise exception/);
    assert.match(c, /commit; notify pgrst, 'reload schema';/);
  });

  test(`${name}: RLS on, everything revoked, authenticated gets SELECT only`, () => {
    assert.match(c, /alter table public\.whiteboard_items enable row level security;/);
    assert.match(c, /alter table public\.whiteboard_pickup_calls enable row level security;/);
    assert.ok(c.includes(`revoke all on table ${TABLES} from public, anon, authenticated;`));
    assert.ok(c.includes(`grant select on table ${TABLES} to authenticated;`));
    assert.ok(c.includes(`grant all on table ${TABLES} to service_role;`));
    const grants = c.match(/grant [a-z, ]+ on table [^;]+ to [^;]+;/g) || [];
    assert.equal(grants.length, 2);
    for (const g of grants) {
      if (/to (anon|public)\b/.test(g)) assert.fail('anon/public granted: ' + g);
      if (/to authenticated/.test(g)) assert.match(g, /^grant select on table/);
    }
  });

  test(`${name}: the only policies are SELECT to authenticated using is_staff()`, () => {
    const pols = c.match(/create policy [^;]+;/g) || [];
    assert.equal(pols.length, 2);
    for (const p of pols) assert.match(p, /^create policy staff_read on public\.whiteboard_(items|pickup_calls) for select to authenticated using \(public\.is_staff\(\)\);$/);
  });

  test(`${name}: realtime for both; soft erase only (no delete, cleared pair + arrived-is-parts checks)`, () => {
    assert.match(c, /alter publication supabase_realtime add table public\.whiteboard_items;/);
    assert.match(c, /alter publication supabase_realtime add table public\.whiteboard_pickup_calls;/);
    assert.doesNotMatch(c.replace(/on delete set null/g, ''), /\bdelete\b|\bdrop table\b|\btruncate\b/);
    assert.match(c, /check \(\(cleared_at is null\) = \(cleared_reason is null\)\)/);
    assert.match(c, /check \(cleared_reason is distinct from 'arrived' or kind = 'parts'\)/);
    assert.match(c, /check \(char_length\(btrim\(text\)\) between 1 and 500\)/);
    assert.match(c, /ro_id uuid primary key references public\.repair_orders\(id\)/);
  });
}
