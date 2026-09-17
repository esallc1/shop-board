-- ============================================================================
-- SECURITY PHASE 2 — M1 (ADDITIVE). PIN hashes move to a table nothing on the API can read.
-- ============================================================================
-- Hand-run in the Supabase SQL editor. Sandbox (efhmefpaijjncwgbvwki) FIRST.
-- Run 20260917_pin_off_public_PREFLIGHT_READONLY.sql before this.
--
-- What it does
--   1. employee_secrets(employee_id, pin_hash, failed_attempts, locked_until):
--      RLS ON, NO policies, all grants revoked from anon/authenticated/public.
--      Only SECURITY DEFINER functions (owned by postgres) can touch it.
--   2. Backfills a bcrypt hash from the CURRENT employees.pin for:
--        • 'Cristian Tech'  — every project (the one PIN in real use; ACTIVE on prod,
--                             retired on the sandbox's stale copy, so it can't log in there)
--        • 'ZZ Test Tech'   — NON-PROD ONLY. Its PIN is written in a wiring doc that
--          was served publicly, so on prod it must never become a working login.
--      `on conflict do nothing`: re-running M1 never overwrites a rotated hash.
--   3. login_with_pin(p_phone, p_pin) — the ONLY way a PIN is checked from now on.
--   4. employees.pin DROP NOT NULL — the GM editor stops sending a PIN, so a new
--      hire must be insertable without one. (M2 drops the column outright.)
--
-- What it does NOT do
--   • Does not touch employees.pin values or its anon readability — the old
--     my-numbers.html on prod still reads it until the branch code ships. M2 closes it.
--   • Does not change employees RLS, employees_visible, or any office (email) login.
--
-- Nothing breaks: the old code never calls the new function, the new code needs it.
-- ============================================================================

-- ── Guard: refuse to run on an unstamped database (staging-db §8) ───────────
do $$
begin
  if not exists (select 1 from public.app_env) then
    raise exception 'public.app_env has no row — which database is this? Refusing to run.';
  end if;
  raise notice 'Running M1 on: %', (select env from public.app_env limit 1);
end $$;

-- pgcrypto: Supabase installs it in `extensions`. No-op if it already exists anywhere.
create extension if not exists pgcrypto with schema extensions;

begin;

set local search_path = public, extensions;

-- ── 1. The secrets table ────────────────────────────────────────────────────
create table if not exists public.employee_secrets (
  employee_id     uuid primary key references public.employees(id) on delete cascade,
  pin_hash        text not null,
  failed_attempts int  not null default 0,
  locked_until    timestamptz
);

comment on table public.employee_secrets is
  'PIN hashes (bcrypt). RLS on, NO policies, no API grants. Read/written ONLY by '
  'SECURITY DEFINER functions (login_with_pin). Never add a policy or a grant here.';

alter table public.employee_secrets enable row level security;
-- Supabase default privileges grant new public tables to anon/authenticated. Undo that.
revoke all on table public.employee_secrets from public, anon, authenticated;

-- ── 2. Backfill — two named rows only ───────────────────────────────────────
insert into public.employee_secrets (employee_id, pin_hash)
select e.id, crypt(e.pin, gen_salt('bf', 8))
  from public.employees e
 where e.pin ~ '^[0-9]{4}$'
   and (   e.name = 'Cristian Tech'
        or (e.name = 'ZZ Test Tech'
            and (select env from public.app_env limit 1) not like 'PROD%'))
on conflict (employee_id) do nothing;

-- ── 3. The login function ───────────────────────────────────────────────────
-- Returns exactly what my-numbers.html keeps: name, phone, role (it uses the
-- phone as the session id — see docs/wiring/my-numbers.md §1). Never the hash,
-- never the id, never a reason.
--
-- ONE failure shape: zero rows. Unknown phone, no secret, inactive, ambiguous
-- phone, malformed input, wrong PIN and LOCKED all look identical, and every
-- path runs exactly one bcrypt so timing doesn't separate them either.
-- 5 wrong PINs → locked 15 minutes (counter resets when the lock is set).
create or replace function public.login_with_pin(p_phone text, p_pin text)
returns table (name text, phone text, role text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
#variable_conflict use_column
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_pin    text := coalesce(p_pin, '');
  v_n      int;
  v_id     uuid;
  v_name   text;
  v_phone  text;
  v_role   text;
  v_hash   text;
  v_locked timestamptz;
begin
  if v_digits !~ '^[0-9]{10}$' or v_pin !~ '^[0-9]{4}$' then
    perform crypt(v_pin, gen_salt('bf', 8));
    return;
  end if;

  -- Ambiguity resolves to nobody (the partial unique index on active phones
  -- should make this impossible; this is the belt to that brace).
  select count(*) into v_n
    from public.employees e
   where e.active
     and regexp_replace(coalesce(e.phone, ''), '[^0-9]', '', 'g') = v_digits;
  if v_n <> 1 then
    perform crypt(v_pin, gen_salt('bf', 8));
    return;
  end if;

  select e.id, e.name::text, e.phone::text, e.role::text, s.pin_hash, s.locked_until
    into v_id, v_name, v_phone, v_role, v_hash, v_locked
    from public.employees e
    join public.employee_secrets s on s.employee_id = e.id
   where e.active
     and regexp_replace(coalesce(e.phone, ''), '[^0-9]', '', 'g') = v_digits
     for update of s;
  if not found then
    perform crypt(v_pin, gen_salt('bf', 8));
    return;
  end if;

  if v_locked is not null and v_locked > now() then
    perform crypt(v_pin, gen_salt('bf', 8));   -- locked: don't even test the PIN
    return;
  end if;

  if crypt(v_pin, v_hash) = v_hash then
    update public.employee_secrets s
       set failed_attempts = 0, locked_until = null
     where s.employee_id = v_id;
    return query select v_name, v_phone, v_role;
  else
    update public.employee_secrets s
       set failed_attempts = case when s.failed_attempts + 1 >= 5 then 0 else s.failed_attempts + 1 end,
           locked_until    = case when s.failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
     where s.employee_id = v_id;
    return;
  end if;
end;
$$;

comment on function public.login_with_pin(text, text) is
  'My Numbers tech login. SECURITY DEFINER over employee_secrets. Zero rows = failure '
  '(any reason, deliberately indistinguishable). 5 failures → 15 min lock.';

revoke all on function public.login_with_pin(text, text) from public;
grant execute on function public.login_with_pin(text, text) to anon, authenticated;

-- ── 4. New hires no longer need a PIN ───────────────────────────────────────
alter table public.employees alter column pin drop not null;

commit;

-- ============================================================================
-- VERIFY (read-only; run after the commit)
-- ============================================================================
-- a) What was backfilled — shape only, never the hash:
--    select e.name, right(e.phone, 4) as phone_last4, e.active,
--           s.failed_attempts, s.locked_until
--      from public.employee_secrets s join public.employees e on e.id = s.employee_id;
--    expect: sandbox → Cristian Tech (active=false, inert) + ZZ Test Tech (active);
--            prod    → Cristian Tech only (active). ZZ Test Tech is inactive on prod anyway.
--
-- b) The API roles cannot read the table (expect: false, false, false, false):
--    select has_table_privilege('anon', 'public.employee_secrets', 'select'),
--           has_table_privilege('authenticated', 'public.employee_secrets', 'select'),
--           has_table_privilege('anon', 'public.employee_secrets', 'update'),
--           (select count(*) from pg_policies where tablename = 'employee_secrets') > 0;
--
-- c) The function is definer, pinned search_path, anon-executable (expect t, {search_path=…}, t):
--    select p.prosecdef, p.proconfig,
--           has_function_privilege('anon', 'public.login_with_pin(text,text)', 'execute')
--      from pg_proc p where p.proname = 'login_with_pin';
--
-- d) Negative call with a phone NOBODY has (expect: 0 rows; writes nothing):
--    select * from public.login_with_pin('5550000000', '0000');
--    ⚠ Do NOT test a wrong PIN against a real phone here — it counts toward the lock.
--
-- e) Over the API as anon (expect 401/42501 — "permission denied for table employee_secrets"):
--    GET https://<ref>.supabase.co/rest/v1/employee_secrets?select=*
--
-- ============================================================================
-- SET / ROTATE A PIN — the only way a PIN is ever set (the GM editor no longer has a PIN field).
-- Do this for Cristian Tech after M2: its current PIN has been anon-readable, treat it as burned.
-- ============================================================================
--    insert into public.employee_secrets (employee_id, pin_hash)
--    select id, extensions.crypt('<NEW 4 DIGITS>', extensions.gen_salt('bf', 8))
--      from public.employees where name = '<NAME>' and active
--    on conflict (employee_id) do update
--       set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null;
--    (If pgcrypto is not in `extensions` — preflight query 9 — drop the `extensions.` prefix.)
--    (The SQL editor keeps query history — clear that snippet afterwards.)
--
-- CLEAR A LOCK:
--    update public.employee_secrets set failed_attempts = 0, locked_until = null
--     where employee_id = (select id from public.employees where name = '<NAME>' and active);
--
-- Rollback: 20260917_pin_off_public_M1_ROLLBACK.sql (roll the CODE back first).
