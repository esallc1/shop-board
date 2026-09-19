-- ============================================================================
-- Job category on the RO — SANDBOX run (efhmefpaijjncwgbvwki / test.*).
-- Prod has its own file: 20260919_ro_job_category_PROD.sql
-- (identical except the inverted guard). Wiring: docs/wiring/ro-checkin-tech.md §7.
--
-- Adds repair_orders.job_category: NULL = "not decided yet", otherwise exactly
-- one of the two values in shared/job-category.js (JOB_CATEGORIES). The CHECK
-- below must list the SAME strings — shared/job-category.test.js fails if the
-- two drift apart.
--
-- RO ONLY: nothing here touches shopboard_lifts / _parking / _pickup.
-- No backfill: every existing RO starts NULL. completed_jobs is untouched (its
-- job_category column already exists; old rows keep Gen Auto / Rebuild / Diag).
--
-- Run BY HAND in the Supabase SQL editor — SANDBOX FIRST, then PROD.
-- Order vs the app: either order is safe. The app hides the dropdown (with a
-- "needs the database update" note) until this column exists, and the close
-- archive only writes the column that completed_jobs already has.
--
-- SELF-GUARDING (staging-db.md §8.2/§8.3): the block refuses to run when app_env is empty or says PROD. It cannot touch prod.
-- Safe to re-run (add column if not exists; the CHECK is added only if missing).
-- ============================================================================

do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then
    raise exception 'app_env HAS NO ROW — STOP. Every guard would silently match nothing. Stamp this database first (staging-db.md §8).';
  end if;
  if v like 'PROD%' then
    raise exception 'WRONG PROJECT: % — this is the SANDBOX file, refusing', v;
  end if;

  -- Nullable, no default → metadata-only, no table rewrite. Existing table RLS
  -- covers the new column (no policy change).
  alter table public.repair_orders
    add column if not exists job_category text;
  comment on column public.repair_orders.job_category is
    'Job category, set on the RO detail. NULL = not decided yet; otherwise one of shared/job-category.js JOB_CATEGORIES. RO only (never mirrored to shopboard_*); copied into completed_jobs.job_category at close.';

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.repair_orders'::regclass
       and conname  = 'repair_orders_job_category_check'
  ) then
    alter table public.repair_orders
      add constraint repair_orders_job_category_check
      check (job_category is null or job_category in ('Transmission rebuild', 'General repair'));
  end if;

  raise notice 'job_category added on %', v;
end $$;

notify pgrst, 'reload schema';

-- VERIFICATION (expect: text / YES / no default; the CHECK text; set_count = 0; the SANDBOX stamp)
--   select env from public.app_env;
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'repair_orders' and column_name = 'job_category';
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.repair_orders'::regclass and conname = 'repair_orders_job_category_check';
--   select count(*) filter (where job_category is not null) as set_count, count(*) as all_ros
--     from public.repair_orders;


-- ════════════════════════════════════════════════════════════════════════════
-- UNDO (not run). Drops the CHECK and the column — any categories picked on ROs
-- since are LOST (completed_jobs rows written at close keep theirs). Deploy the
-- app version without the dropdown first, or it will show its
-- "needs the database update" note again (harmless).
--
--   alter table public.repair_orders drop constraint if exists repair_orders_job_category_check;
--   alter table public.repair_orders drop column if exists job_category;
--   notify pgrst, 'reload schema';
-- ════════════════════════════════════════════════════════════════════════════
