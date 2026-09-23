/* ============================================================
   social-messaging-migration.test.js — the Messenger tables' security posture.
   Run: npm test   (node --test)

   Static checks on migrations/20260923_social_messaging_{SANDBOX,PROD}.sql
   (hand-run SQL — nothing here touches a database). Locks:
     • the two files are the same apart from the header + the inverted guard;
     • anon / authenticated get every table privilege REVOKED and only
       authenticated gets SELECT back — never insert/update/delete/all;
     • the only policies are SELECT, to authenticated, using is_staff();
     • social_record_message is security definer with a pinned search_path,
       revoked from public/anon/authenticated and granted to service_role ONLY;
     • the writer never assigns done_at / done_by / customer_id / linked_*.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SANDBOX = readFileSync(join(DIR, '20260923_social_messaging_SANDBOX.sql'), 'utf8');
const PROD = readFileSync(join(DIR, '20260923_social_messaging_PROD.sql'), 'utf8');
const FILES = { SANDBOX, PROD };

// SQL with the `--` comments removed, whitespace collapsed, lowercased — so the
// verify block's commented-out statements can never satisfy (or fail) a check.
function code(sql) {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/\s+/g, ' ').toLowerCase();
}

const FN_SIG = 'public.social_record_message(text,text,text,text,text,boolean,text,text,text,jsonb,timestamptz,uuid,text,text,text)';

test('SANDBOX and PROD differ only in the header lines and the guard', () => {
  const a = SANDBOX.split('\n');
  const b = PROD.split('\n');
  assert.equal(a.length, b.length);
  const diffs = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  assert.equal(diffs.length, 3, 'expected exactly 3 differing lines');
  for (const i of diffs) {
    const both = a[i] + '\n' + b[i];
    assert.ok(/^--/.test(a[i]) || /raise exception 'WRONG PROJECT/.test(both), `unexpected diff at line ${i + 1}`);
  }
  assert.match(SANDBOX, /if v like 'PROD%' then raise exception 'WRONG PROJECT/);
  assert.match(PROD, /if v not like 'PROD%' then raise exception 'WRONG PROJECT/);
});

for (const [name, sql] of Object.entries(FILES)) {
  const c = code(sql);

  test(`${name}: guarded + one transaction`, () => {
    assert.match(c, /^ ?begin; do \$\$ declare v text; begin select env into v from public\.app_env/);
    assert.match(c, /app_env has no row/);
    assert.match(c, /commit; notify pgrst, 'reload schema';/);
  });

  test(`${name}: RLS on, anon/authenticated writes revoked, authenticated gets SELECT only`, () => {
    assert.match(c, /alter table public\.social_threads enable row level security;/);
    assert.match(c, /alter table public\.social_messages enable row level security;/);
    assert.match(c, /revoke all on table public\.social_threads, public\.social_messages from public, anon, authenticated;/);
    assert.match(c, /grant select on table public\.social_threads, public\.social_messages to authenticated;/);
    // No grant of anything to anon, and no write grant to authenticated, anywhere.
    for (const g of c.matchAll(/grant ([^;]*?) to ([^;]*);/g)) {
      const [, what, who] = g;
      assert.ok(!/\banon\b/.test(who), `grant to anon: ${g[0]}`);
      if (/\bauthenticated\b/.test(who) && /\bon table\b/.test(what)) {
        assert.ok(/^select on table/.test(what.trim()), `non-SELECT table grant to authenticated: ${g[0]}`);
      }
    }
  });

  test(`${name}: the only policies are SELECT to authenticated using is_staff()`, () => {
    const policies = [...c.matchAll(/create policy [^;]*;/g)].map((m) => m[0]);
    assert.equal(policies.length, 2);
    for (const p of policies) {
      assert.match(p, / for select to authenticated using \(public\.is_staff\(\)\);$/);
    }
    assert.doesNotMatch(c, /for (insert|update|delete|all) to/);
  });

  test(`${name}: is_staff checks an ACTIVE employee by auth.uid(), not anon-executable`, () => {
    assert.match(c, /create or replace function public\.is_staff\(\) returns boolean language sql stable security definer set search_path = public, pg_temp/);
    assert.match(c, /where auth_user_id = auth\.uid\(\) and active is true/);
    assert.match(c, /revoke all on function public\.is_staff\(\) from public, anon;/);
    assert.doesNotMatch(c, /grant execute on function public\.is_staff\(\) to [^;]*\banon\b/);
  });

  test(`${name}: social_record_message is definer, pinned, service_role ONLY`, () => {
    assert.match(c, /create or replace function public\.social_record_message\(/);
    const head = c.slice(c.indexOf('create or replace function public.social_record_message('), c.indexOf('as $fn$ #variable_conflict'));
    assert.match(head, /security definer set search_path = public, pg_temp $/);
    const sig = FN_SIG.toLowerCase();
    assert.ok(c.includes(`revoke all on function ${sig} from public, anon, authenticated;`), 'revoke missing');
    const grants = [...c.matchAll(/grant execute on function public\.social_record_message\([^)]*\) to ([^;]*);/g)];
    assert.equal(grants.length, 1);
    assert.equal(grants[0][1].trim(), 'service_role');
  });

  test(`${name}: the writer is idempotent on mid and never writes a human's fields`, () => {
    const start = c.indexOf('create or replace function public.social_record_message(');
    const body = c.slice(c.indexOf('as $fn$', start), c.indexOf('$fn$;', start + 10));
    assert.match(body, /on conflict \(mid\) do nothing/);
    assert.match(body, /on conflict \(channel, page_id, psid\) do nothing/);
    for (const col of ['done_at', 'done_by', 'customer_id', 'linked_at', 'linked_by']) {
      assert.ok(!body.includes(col), `writer mentions ${col}`);
    }
    // Race fields are only filled when empty.
    assert.match(body, /sent_by = coalesce\(m\.sent_by, p_sent_by\)/);
    assert.match(body, /send_status = coalesce\(m\.send_status, p_send_status\)/);
    assert.match(body, /where t\.id = v_thread and t\.display_name is null/);
    // Clocks only move forward.
    assert.match(body, /last_message_at = greatest\(t\.last_message_at, p_sent_at\)/);
    assert.match(body, /then greatest\(t\.last_inbound_at, p_sent_at\)/);
  });

  test(`${name}: mid unique, cascade delete, realtime on both tables`, () => {
    assert.match(c, /constraint social_messages_mid_key unique \(mid\)/);
    assert.match(c, /references public\.social_threads\(id\) on delete cascade/);
    assert.match(c, /customer_id uuid references public\.customers\(id\) on delete set null/);
    assert.match(c, /channel in \('facebook','instagram'\)/);
    assert.match(c, /alter publication supabase_realtime add table public\.social_threads;/);
    assert.match(c, /alter publication supabase_realtime add table public\.social_messages;/);
  });
}
