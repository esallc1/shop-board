-- ============================================================================
-- SECURITY PHASE 2 — PREFLIGHT (READ-ONLY). Run on BOTH projects, sandbox first.
-- ============================================================================
-- Writes nothing. Paste each result back before M1 / M2 are run.
--
-- Why this exists: `alter table employees drop column pin` FAILS if any view,
-- rule or policy depends on the column, and silently BREAKS (at call time, not
-- at drop time) any plpgsql function whose body names it. The repo can only
-- prove one dependent (employees_visible, a `select *` view); these queries are
-- the ground truth for the rest. M2 also refuses to run unless its explicit
-- column list equals (employees columns − pin), so query 2 is what M2 is
-- checked against.
-- ============================================================================

set default_transaction_read_only = on;

-- 1. Which database am I on? (staging-db §8)
select env from public.app_env;

-- 2. employees columns — M2's explicit view list must equal this minus `pin`.
select ordinal_position, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'employees'
 order by ordinal_position;

-- 3. The current view: definition, options (expect security_invoker=true), grants.
select pg_get_viewdef('public.employees_visible'::regclass, true) as viewdef;
select reloptions from pg_class where oid = 'public.employees_visible'::regclass;
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'employees_visible'
 order by grantee, privilege_type;

-- 4. Views / rules that depend on the employees.pin COLUMN (a drop fails on these).
select distinct dc.oid::regclass as dependent, dc.relkind
  from pg_depend d
  join pg_rewrite r   on r.oid = d.objid
  join pg_class dc    on dc.oid = r.ev_class
  join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
 where d.refobjid = 'public.employees'::regclass
   and a.attname = 'pin';

-- 5. Anything that depends on employees_visible itself (M2 drops + recreates it).
select distinct dc.oid::regclass as dependent, dc.relkind
  from pg_depend d
  join pg_rewrite r on r.oid = d.objid
  join pg_class dc  on dc.oid = r.ev_class
 where d.refobjid = 'public.employees_visible'::regclass
   and dc.oid <> 'public.employees_visible'::regclass;

-- 6. Policies (any table) whose expression names `pin`.
select schemaname, tablename, policyname, cmd, roles, qual, with_check
  from pg_policies
 where coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* '\mpin\M';

-- 7. Functions whose BODY names `pin` (not tracked by pg_depend — they break at call time).
select n.nspname as schema, p.proname, p.prosecdef as security_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog', 'information_schema', 'extensions', 'auth', 'storage', 'realtime', 'graphql', 'graphql_public', 'vault', 'pgsodium')
   and p.prosrc ~* '\mpin\M';

-- 8. Triggers, constraints and indexes on employees (anything naming pin?).
select tgname, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.employees'::regclass and not tgisinternal;
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.employees'::regclass;
select indexname, indexdef from pg_indexes
 where schemaname = 'public' and tablename = 'employees';

-- 9. Where pgcrypto lives (login_with_pin sets search_path = public, extensions).
select e.extname, n.nspname as schema, e.extversion
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
 where e.extname = 'pgcrypto';

-- 10. The two rows M1 backfills — shape only, NEVER the PIN value.
select name, right(phone, 4) as phone_last4, active, is_test,
       (pin ~ '^[0-9]{4}$') as pin_is_4_digits
  from public.employees
 where name in ('Cristian Tech', 'ZZ Test Tech')
 order by name, active desc;

-- 11. Publications with a COLUMN LIST on employees (a column drop fails on those).
select pubname, attnames from pg_publication_tables
 where schemaname = 'public' and tablename = 'employees';

-- 12. Nothing Phase 2 creates exists yet (expect: both false).
select to_regclass('public.employee_secrets') is not null as secrets_exists,
       exists (select 1 from pg_proc where proname = 'login_with_pin') as fn_exists;
