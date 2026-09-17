-- ============================================================================
-- SECURITY PHASE 2 — M2 (DESTRUCTIVE). Drop employees.pin; view gets an explicit column list.
-- ============================================================================
-- ✅ APPLIED 2026-09-17 — sandbox (efhmefpaijjncwgbvwki) then prod (hygemiszxwmyrkmhbjub), both verified, code at 1f55c3e live on main + staging first.
--    Verified on both: employees.pin gone; employees_visible = the 13 columns below,
--    security_invoker=true, grants identical to the preflight capture (prod: 16 rows).
--    Anon on prod: employees?select=pin → 400 42703 (was 200), employee_secrets → 401 42501.
-- Hand-run in the Supabase SQL editor. Sandbox FIRST, retest, then prod.
--
-- PRECONDITIONS (the guard below enforces the ones it can):
--   • M1 has run on THIS project (employee_secrets + login_with_pin exist).
--   • The Phase-2 code is LIVE on the surface this project serves (sandbox → test.*,
--     prod → leetransmissionshop.com). The old my-numbers.html selects `pin` and
--     the old gm-board.html writes it — both error the moment the column is gone.
--   • On prod: Cris has logged in as Cristian Tech through login_with_pin.
--   • The column list below matches preflight query 2 as run on BOTH projects
--     2026-09-17: 14 columns, identical order, minus `pin` = 13. If the schema
--     has drifted since, the post-check raises, naming the missing / extra
--     columns, and the whole transaction rolls back — nothing changes.
--
-- IRREVERSIBLE for the PIN values: they exist only as bcrypt hashes after this.
-- (Accepted — see the M2 rollback.)
--
-- Why drop + create and not `create or replace view`: `select *` was expanded at
-- creation, so the view has a hard dependency on `pin`; a replacement view may
-- not drop a column. Grants are captured from the live ACL and re-applied, so
-- anon/authenticated keep exactly the access they have today.
-- ============================================================================

do $$
begin
  if not exists (select 1 from public.app_env) then
    raise exception 'public.app_env has no row — which database is this? Refusing to run.';
  end if;
  if to_regclass('public.employee_secrets') is null
     or not exists (select 1 from pg_proc where proname = 'login_with_pin') then
    raise exception 'M1 has not run here (employee_secrets / login_with_pin missing). Refusing.';
  end if;
  if (select env from public.app_env limit 1) like 'PROD%'
     and not exists (select 1 from public.employee_secrets s
                       join public.employees e on e.id = s.employee_id
                      where e.name = 'Cristian Tech' and e.active) then
    raise exception 'PROD: active Cristian Tech has no PIN hash — dropping pin would lock Cris out. Refusing.';
  end if;
  raise notice 'Running M2 on: %', (select env from public.app_env limit 1);
end $$;

begin;

-- ── 1. Capture the view's current ACL, exactly ──────────────────────────────
create temp table _ev_acl on commit drop as
select a.grantee, a.privilege_type
  from pg_class c, aclexplode(c.relacl) a
 where c.oid = 'public.employees_visible'::regclass;

-- ── 2. Recreate the view without pin ────────────────────────────────────────
drop view public.employees_visible;

create view public.employees_visible
  with (security_invoker = true)
as
select id,
       name,
       phone,
       role,
       active,
       photo_url,
       created_at,
       background_photo_url,
       avatar_path,
       auth_user_id,              -- kept: nothing resolves identity through the view
                                  -- (all auth lookups hit employees directly), but
                                  -- removing it is a separate decision, not this one
       commission_base_weekly,
       commission_gp_pct,
       is_test
  from public.employees
 where not is_test;

comment on view public.employees_visible is
  'Human-facing roster: employees minus is_test rows. EXPLICIT column list — a new '
  'employees column is NOT exposed until added here. Never add pin / secrets.';

-- ── 3. Re-apply the captured grants ─────────────────────────────────────────
do $$
declare r record;
begin
  if not exists (select 1 from _ev_acl) then
    raise notice 'employees_visible had a NULL ACL (defaults) — left the new view on defaults.';
    return;
  end if;
  execute 'revoke all on public.employees_visible from public, anon, authenticated, service_role';
  for r in select * from _ev_acl loop
    execute format('grant %s on public.employees_visible to %s',
                   r.privilege_type,
                   case when r.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
end $$;

-- ── 4. Drop the column (no CASCADE: any other dependent must fail loudly) ───
alter table public.employees drop column pin;

-- ── 5. Post-check inside the transaction: raise → everything above rolls back ─
do $$
declare v_missing text; v_extra text;
begin
  select string_agg(column_name, ', ') into v_missing
    from information_schema.columns
   where table_schema = 'public' and table_name = 'employees'
     and column_name not in (select column_name from information_schema.columns
                              where table_schema = 'public' and table_name = 'employees_visible');
  select string_agg(column_name, ', ') into v_extra
    from information_schema.columns
   where table_schema = 'public' and table_name = 'employees_visible'
     and column_name not in (select column_name from information_schema.columns
                              where table_schema = 'public' and table_name = 'employees');
  if v_missing is not null or v_extra is not null then
    raise exception 'employees_visible column list is wrong — in employees but not the view: [%]; in the view but not employees: [%]. Fix the list in M2 and re-run. NOTHING was changed.',
      coalesce(v_missing, ''), coalesce(v_extra, '');
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'employees' and column_name = 'pin') then
    raise exception 'pin still present — refusing to commit.';
  end if;
  if not exists (select 1 from pg_class
                  where oid = 'public.employees_visible'::regclass
                    and 'security_invoker=true' = any (reloptions)) then
    raise exception 'employees_visible lost security_invoker — refusing to commit.';
  end if;
end $$;

commit;

-- ============================================================================
-- VERIFY
-- ============================================================================
-- a) Grants on the view match preflight query 3:
--    select grantee, privilege_type from information_schema.role_table_grants
--     where table_schema='public' and table_name='employees_visible' order by 1, 2;
--
-- b) Over the API as anon — the proof the plan closes on:
--    GET /rest/v1/employees?select=pin          before: 200   after: 400 (42703 column does not exist)
--    GET /rest/v1/employees_visible?select=pin  before: 200   after: 400
--    GET /rest/v1/employees_visible?select=id,name&limit=1    still 200
--
-- c) Cristian Tech logs in on my-numbers.html; Kevin/Daiana/Manny/Cris email logins
--    land on their boards with "Hi, <name>"; GM → Employees list loads and an edit saves.
--
-- Rollback: 20260917_pin_off_public_M2_ROLLBACK.sql (restores the column EMPTY).
