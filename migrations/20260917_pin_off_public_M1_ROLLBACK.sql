-- ============================================================================
-- SECURITY PHASE 2 — M1 ROLLBACK
-- ============================================================================
-- ⚠ ROLL THE CODE BACK FIRST. Once my-numbers.html calls login_with_pin, dropping
--   the function makes every PIN login fail. Order: revert the branch deploy →
--   confirm /api/version shows the pre-Phase-2 SHA → then run this.
-- ⚠ Only valid while M2 has NOT run (employees.pin must still exist). **M2 HAS run on both
--   projects (2026-09-17), so this file is dead for those two** — the guard below refuses, and
--   you would have to run the M2 rollback first (which cannot bring the old PIN values back).
--
-- Undoes, in reverse: the NOT NULL relaxation, the function, the secrets table.
-- The hashes are discarded; employees.pin was never modified by M1, so the old
-- client-side login works again exactly as before.
-- ============================================================================

do $$
begin
  if not exists (select 1 from public.app_env) then
    raise exception 'public.app_env has no row — which database is this? Refusing to run.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'employees' and column_name = 'pin') then
    raise exception 'employees.pin is gone — M2 already ran. Run the M2 rollback first (PIN values are NOT recoverable).';
  end if;
  raise notice 'Rolling back M1 on: %', (select env from public.app_env limit 1);
end $$;

begin;

drop function if exists public.login_with_pin(text, text);
drop table if exists public.employee_secrets;

-- Restore NOT NULL only if every row still has a PIN. A hire added through the
-- new GM editor has none; don't invent one — report it and leave the column nullable.
do $$
declare v_nulls int;
begin
  select count(*) into v_nulls from public.employees where pin is null;
  if v_nulls = 0 then
    alter table public.employees alter column pin set not null;
  else
    raise notice '% employees row(s) have no PIN (added after M1) — employees.pin left NULLABLE. '
                 'Give them a PIN by hand, then: alter table public.employees alter column pin set not null;', v_nulls;
  end if;
end $$;

commit;

-- VERIFY (expect: false, false, 'NO' — or 'YES' if the notice above fired):
--   select to_regclass('public.employee_secrets') is not null,
--          exists (select 1 from pg_proc where proname = 'login_with_pin'),
--          (select is_nullable from information_schema.columns
--            where table_schema='public' and table_name='employees' and column_name='pin');
