-- ============================================================================
-- SECURITY PHASE 2 — M2 ROLLBACK (restores the SHAPE, not the values)
-- ============================================================================
-- Not used: M2 ran cleanly on both projects 2026-09-17 and the live PIN login was retested
-- after each drop. Kept because the only way back is through this file.
--
-- ⚠ The old PIN values are GONE. This brings back an EMPTY, nullable
--   employees.pin and the old `select *` view, so pre-Phase-2 code stops
--   erroring on the missing column — but that old code still cannot log anyone
--   in with a PIN (every pin is NULL). Accepted in the plan.
-- Tech login keeps working through login_with_pin regardless: M1 is untouched.
-- If the plaintext column ever has to hold a value again, set it by hand.
-- ============================================================================

do $$
begin
  if not exists (select 1 from public.app_env) then
    raise exception 'public.app_env has no row — which database is this? Refusing to run.';
  end if;
  raise notice 'Rolling back M2 on: %', (select env from public.app_env limit 1);
end $$;

begin;

create temp table _ev_acl on commit drop as
select a.grantee, a.privilege_type
  from pg_class c, aclexplode(c.relacl) a
 where c.oid = 'public.employees_visible'::regclass;

alter table public.employees add column if not exists pin text;   -- nullable, empty

drop view public.employees_visible;
create view public.employees_visible
  with (security_invoker = true)
as
select * from public.employees where not is_test;

do $$
declare r record;
begin
  if not exists (select 1 from _ev_acl) then return; end if;
  execute 'revoke all on public.employees_visible from public, anon, authenticated, service_role';
  for r in select * from _ev_acl loop
    execute format('grant %s on public.employees_visible to %s',
                   r.privilege_type,
                   case when r.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
end $$;

commit;

-- VERIFY (expect: 'pin' appears in both):
--   select table_name, column_name from information_schema.columns
--    where table_schema='public' and table_name in ('employees','employees_visible') and column_name='pin';
