-- ============================================================================
-- STAGING TAIL — run AFTER restoring the prod public schema (pg_dump --schema-only)
-- and BEFORE (or after) the data load. Two jobs the -n public schema dump can't do:
--   (1) guarantee BOTH {anon} and {authenticated} full-access policies on every
--       public table (prod only sets `authenticated` on a handful);
--   (2) give staging permissive Storage policies for the app's buckets, so anon +
--       authenticated can upload/read during write-testing (the schema dump is
--       -n public, so it carries no storage.objects policies).
-- Idempotent + wrapped in one transaction. Safe to re-run.
-- ============================================================================
begin;

-- (1) Public tables: ensure anon + authenticated permissive FOR ALL policies.
do $$
declare r record; role_name text; pol_name text;
begin
  for r in
    select c.relname as tbl from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', r.tbl);
    foreach role_name in array array['anon','authenticated'] loop
      if not exists (
        select 1 from pg_policies p
        where p.schemaname='public' and p.tablename=r.tbl
          and p.cmd='ALL' and p.permissive='PERMISSIVE'
          and role_name = any(p.roles)
      ) then
        pol_name := format('staging_%s_full_access_%s', role_name, r.tbl);
        execute format('create policy %I on public.%I for all to %I using (true) with check (true)',
                       pol_name, r.tbl, role_name);
      end if;
    end loop;
  end loop;
end $$;

-- (2) Storage: permissive anon + authenticated access on the app's buckets.
-- (Full access is fine on a practice DB and matches the {anon}+{authenticated}
-- convention; RLS on storage.objects is already enabled by Supabase.)
do $$
declare b text; role_name text; pol_name text;
  buckets text[] := array[
    'crisdata-attachments','attachments','employee-photos','board-backgrounds',
    'call-recordings','invoice-images','marketing-content'
  ];
begin
  foreach b in array buckets loop
    foreach role_name in array array['anon','authenticated'] loop
      pol_name := format('staging_%s_storage_%s', role_name, b);
      if not exists (select 1 from pg_policies
                     where schemaname='storage' and tablename='objects' and policyname=pol_name) then
        execute format(
          'create policy %I on storage.objects for all to %I using (bucket_id = %L) with check (bucket_id = %L)',
          pol_name, role_name, b, b);
      end if;
    end loop;
  end loop;
end $$;

commit;
