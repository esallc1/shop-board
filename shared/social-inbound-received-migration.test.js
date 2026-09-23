/* ============================================================
   social-inbound-received-migration.test.js — the sent-before-Done fix.
   Run: npm test   (node --test)

   Static checks on migrations/20260923_social_inbound_received_{SANDBOX,PROD}.sql
   (hand-run SQL — nothing here touches a database). Locks:
     • the two files differ only in the header + the inverted guard;
     • guarded, one transaction, refuses to run before the step-1 tables exist;
     • adds last_inbound_received_at and backfills it from last_inbound_at;
     • the writer stamps it ONLY for a NEW inbound message (inside the
       `if v_message is not null` branch, direction 'in'), still never writes a
       human's fields, is still definer + pinned + service_role ONLY;
     • the old clock rules are unchanged (last_inbound_at still Meta's time).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SANDBOX = readFileSync(join(DIR, '20260923_social_inbound_received_SANDBOX.sql'), 'utf8');
const PROD = readFileSync(join(DIR, '20260923_social_inbound_received_PROD.sql'), 'utf8');
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/\s+/g, ' ').toLowerCase();
const SIG = 'public.social_record_message(text,text,text,text,text,boolean,text,text,text,jsonb,timestamptz,uuid,text,text,text)';

test('SANDBOX and PROD differ only in the header lines and the guard', () => {
  const a = SANDBOX.split('\n'), b = PROD.split('\n');
  assert.equal(a.length, b.length);
  const diffs = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  assert.equal(diffs.length, 3);
  assert.match(SANDBOX, /if v like 'PROD%' then raise exception 'WRONG PROJECT/);
  assert.match(PROD, /if v not like 'PROD%' then raise exception 'WRONG PROJECT/);
});

for (const [name, sql] of Object.entries({ SANDBOX, PROD })) {
  const c = code(sql);
  const fnStart = c.indexOf('create or replace function public.social_record_message(');
  const body = c.slice(c.indexOf('as $fn$', fnStart), c.indexOf('$fn$;', fnStart + 10));

  test(`${name}: guarded, one transaction, needs the step-1 tables`, () => {
    assert.match(c, /^ ?begin; do \$\$ declare v text; begin select env into v from public\.app_env/);
    assert.match(c, /to_regclass\('public\.social_threads'\) is null then raise exception/);
    assert.match(c, /commit; notify pgrst, 'reload schema';/);
  });

  test(`${name}: adds the column and backfills it from last_inbound_at`, () => {
    assert.match(c, /alter table public\.social_threads add column if not exists last_inbound_received_at timestamptz;/);
    assert.match(c, /update public\.social_threads set last_inbound_received_at = last_inbound_at where last_inbound_received_at is null and last_inbound_at is not null;/);
  });

  test(`${name}: the arrival stamp is only for a NEW inbound message, and always for one`, () => {
    const split = body.indexOf(' else select m.id into v_message');   // the re-delivery branch
    assert.ok(split > 0);
    const newBranch = body.slice(body.indexOf('if v_message is not null then'), split);
    assert.match(newBranch, /last_inbound_received_at = case when p_direction = 'in' then greatest\(t\.last_inbound_received_at, now\(\)\) else t\.last_inbound_received_at end/);
    // a new inbound always updates (a late delivery has an OLDER Meta timestamp)
    assert.match(newBranch, /where t\.id = v_thread and \(p_direction = 'in' or t\.last_message_at is null or t\.last_message_at < p_sent_at\)/);
    // the re-delivery branch never mentions it
    const dupBranch = body.slice(split);
    assert.ok(!dupBranch.includes('last_inbound_received_at'), 're-delivery branch stamps arrival');
    assert.equal((body.match(/last_inbound_received_at =/g) || []).length, 1);
  });

  test(`${name}: last_inbound_at is still Meta's time (the 24h window), clocks still only forward`, () => {
    assert.match(body, /last_inbound_at = case when p_direction = 'in' then greatest\(t\.last_inbound_at, p_sent_at\) else t\.last_inbound_at end/);
    assert.match(body, /last_message_at = greatest\(t\.last_message_at, p_sent_at\)/);
    assert.match(body, /on conflict \(mid\) do nothing/);
  });

  test(`${name}: still never writes a human's fields; definer, pinned, service_role ONLY`, () => {
    for (const col of ['done_at', 'done_by', 'customer_id', 'linked_at', 'linked_by']) assert.ok(!body.includes(col), `writes ${col}`);
    const head = c.slice(fnStart, c.indexOf('as $fn$', fnStart));
    assert.match(head, /security definer set search_path = public, pg_temp $/);
    assert.ok(c.includes(`revoke all on function ${SIG.toLowerCase()} from public, anon, authenticated;`));
    const grants = [...c.matchAll(/grant ([^;]*?) to ([^;]*);/g)];
    assert.equal(grants.length, 1);
    assert.equal(grants[0][2].trim(), 'service_role');
    assert.doesNotMatch(c, /create policy|grant select|grant insert|grant update|grant all/);
  });
}
