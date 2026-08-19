-- ============================================================================
-- STORAGE — every bucket and every policy, in ONE place. Idempotent.
-- Safe to run on ANY environment, prod included: every statement is
-- `on conflict do nothing` or `drop policy if exists` + `create policy`.
--
-- WHY THIS FILE EXISTS
-- Buckets had no migration home. They were created as side-effects of whichever
-- feature first needed one, spread across five files —
--   invoice-images        20260713_invoice_queue.sql        (+ _delete, _date)
--   board-backgrounds     20260714_board_backgrounds.sql
--   marketing-content     20260716_marketing_content.sql
--   crisdata-attachments  20260716_ro_foundation.sql
--   call-recordings       20260729_recordings.sql
--   employee-photos       NOWHERE — created by hand in the dashboard
-- — plus the authenticated half added later by
--   20260801_office_auth_widen_step1_5.sql (PARTS 3 + 4).
-- Nothing anywhere stated the storage layout, so a fresh environment had no way
-- to reproduce it.
--
-- WHAT THAT COST (2026-08-19): the staging sandbox `efhmefpaijjncwgbvwki` was
-- built with ZERO buckets. `staging/staging-rls-and-storage.sql` created storage
-- POLICIES but never the BUCKETS, and a policy on a bucket that does not exist
-- does nothing. docs/wiring/staging-db.md Step 4a left bucket creation as a
-- manual dashboard step, which was never done and which nothing verified. Every
-- storage-dependent feature on test.leetransmissionshop.com was silently dead
-- for weeks — catch-moment, Capture Invoice, To-Do and chat attachments,
-- Requests screenshots, diagnosis audio, employee photos — and it only surfaced
-- when RO photo upload tried to write. THIS FILE IS THE FIX: run it, and an
-- environment has storage.
--
-- ⚠️ RUNNING THIS ON PROD IS SAFE BUT ADDS ONE REDUNDANT POLICY.
--    Prod's `employee-photos` policy was made in the dashboard and carries a
--    GENERATED NAME that is not knowable from this repo. This file creates the
--    same POSTURE under a deterministic name, so on prod you end up with two
--    permissive policies that do the same thing. Permissive policies OR
--    together, so behaviour is unchanged. To tidy it, confirm the old one and
--    drop it BY HAND after this has run:
--      select policyname, cmd, roles from pg_policies
--       where schemaname='storage' and tablename='objects'
--         and qual like '%employee-photos%';
--
-- ⚠️ UNVERIFIED ON PROD: `employee-photos`.`file_size_limit` and
--    `allowed_mime_types`. This file does not set them (leaving Supabase's
--    defaults), because setting them to a guess would be worse than leaving
--    them alone. If prod has limits configured, they are NOT reproduced here:
--      select id, public, file_size_limit, allowed_mime_types
--        from storage.buckets where id = 'employee-photos';
--    Its `public = true` IS established — 20260801 PART 3 calls it a PUBLIC
--    bucket, PART 4 records its policy as ALL {public}, and gm-board.html reads
--    it via getPublicUrl, which only resolves on a public bucket.
-- ============================================================================


-- ── 1. THE BUCKETS ─────────────────────────────────────────────────────────
-- Flags are prod's, copied from the migrations named above. Only
-- board-backgrounds and employee-photos are public; those two are read with
-- getPublicUrl. Everything else is private and read via createSignedUrl.
insert into storage.buckets (id, name, public) values
  ('invoice-images',       'invoice-images',       false),
  ('board-backgrounds',    'board-backgrounds',    true),
  ('marketing-content',    'marketing-content',    false),
  ('crisdata-attachments', 'crisdata-attachments', false),
  ('call-recordings',      'call-recordings',      false),
  ('employee-photos',      'employee-photos',      true)
on conflict (id) do nothing;


-- ── 2. THE POLICIES ────────────────────────────────────────────────────────
-- BEST-EFFORT BY DESIGN. `storage.objects` is owned by supabase_storage_admin
-- and some projects do not let the SQL-editor role add policies to it. Each
-- policy is wrapped so an ownership error becomes a NOTICE instead of rolling
-- back the whole file — the buckets in part 1 still land. If you see NOTICEs,
-- add those policies in Storage -> Policies in the dashboard.
--
-- `call-recordings` deliberately gets NO policies: private, service-role only,
-- matching 20260729_recordings.sql ("NO storage.objects policies are added ...
-- matching the zero-policy stance above"). Its reads are signed server-side by
-- api/recording-links.js with the service-role key.
--
-- Note `crisdata-attachments` is INSERT + SELECT only for both roles — no
-- delete. That is prod's posture and it is preserved deliberately: the boards
-- delete an attachments ROW without removing the storage object.
do $do$
declare r record;
begin
  for r in
    select * from (values
      -- ══ anon ══
      ('Allow anon insert to invoice-images',
       $q$create policy "Allow anon insert to invoice-images" on storage.objects for insert to anon with check (bucket_id = 'invoice-images')$q$),
      ('Allow anon read invoice-images',
       $q$create policy "Allow anon read invoice-images" on storage.objects for select to anon using (bucket_id = 'invoice-images')$q$),
      ('Allow anon delete invoice-images',
       $q$create policy "Allow anon delete invoice-images" on storage.objects for delete to anon using (bucket_id = 'invoice-images')$q$),
      ('Allow anon update invoice-images',
       $q$create policy "Allow anon update invoice-images" on storage.objects for update to anon using (bucket_id = 'invoice-images') with check (bucket_id = 'invoice-images')$q$),

      ('Allow anon insert to board-backgrounds',
       $q$create policy "Allow anon insert to board-backgrounds" on storage.objects for insert to anon with check (bucket_id = 'board-backgrounds')$q$),
      ('Allow anon read board-backgrounds',
       $q$create policy "Allow anon read board-backgrounds" on storage.objects for select to anon using (bucket_id = 'board-backgrounds')$q$),

      ('Allow anon insert to marketing-content',
       $q$create policy "Allow anon insert to marketing-content" on storage.objects for insert to anon with check (bucket_id = 'marketing-content')$q$),
      ('Allow anon read marketing-content',
       $q$create policy "Allow anon read marketing-content" on storage.objects for select to anon using (bucket_id = 'marketing-content')$q$),
      ('Allow anon delete marketing-content',
       $q$create policy "Allow anon delete marketing-content" on storage.objects for delete to anon using (bucket_id = 'marketing-content')$q$),

      ('Allow anon insert to crisdata-attachments',
       $q$create policy "Allow anon insert to crisdata-attachments" on storage.objects for insert to anon with check (bucket_id = 'crisdata-attachments')$q$),
      ('Allow anon read crisdata-attachments',
       $q$create policy "Allow anon read crisdata-attachments" on storage.objects for select to anon using (bucket_id = 'crisdata-attachments')$q$),

      -- ══ authenticated ══ (20260801 PART 3 reads + PART 4 writes)
      -- Reads cover the PRIVATE buckets only; board-backgrounds and
      -- employee-photos are public and read via getPublicUrl.
      ('Allow authenticated read crisdata-attachments',
       $q$create policy "Allow authenticated read crisdata-attachments" on storage.objects for select to authenticated using (bucket_id = 'crisdata-attachments')$q$),
      ('Allow authenticated read invoice-images',
       $q$create policy "Allow authenticated read invoice-images" on storage.objects for select to authenticated using (bucket_id = 'invoice-images')$q$),
      ('Allow authenticated read marketing-content',
       $q$create policy "Allow authenticated read marketing-content" on storage.objects for select to authenticated using (bucket_id = 'marketing-content')$q$),

      ('Allow authenticated insert crisdata-attachments',
       $q$create policy "Allow authenticated insert crisdata-attachments" on storage.objects for insert to authenticated with check (bucket_id = 'crisdata-attachments')$q$),
      ('Allow authenticated insert marketing-content',
       $q$create policy "Allow authenticated insert marketing-content" on storage.objects for insert to authenticated with check (bucket_id = 'marketing-content')$q$),
      ('Allow authenticated delete marketing-content',
       $q$create policy "Allow authenticated delete marketing-content" on storage.objects for delete to authenticated using (bucket_id = 'marketing-content')$q$),
      ('Allow authenticated insert invoice-images',
       $q$create policy "Allow authenticated insert invoice-images" on storage.objects for insert to authenticated with check (bucket_id = 'invoice-images')$q$),
      ('Allow authenticated update invoice-images',
       $q$create policy "Allow authenticated update invoice-images" on storage.objects for update to authenticated using (bucket_id = 'invoice-images') with check (bucket_id = 'invoice-images')$q$),
      ('Allow authenticated delete invoice-images',
       $q$create policy "Allow authenticated delete invoice-images" on storage.objects for delete to authenticated using (bucket_id = 'invoice-images')$q$),
      ('Allow authenticated insert board-backgrounds',
       $q$create policy "Allow authenticated insert board-backgrounds" on storage.objects for insert to authenticated with check (bucket_id = 'board-backgrounds')$q$),

      -- ══ employee-photos ══ RECONSTRUCTED, not copied. See the header: prod's
      -- equivalent has a dashboard-generated name. `to public` covers anon AND
      -- authenticated, which is why 20260801 omitted it as "nothing to widen".
      ('Allow public all employee-photos',
       $q$create policy "Allow public all employee-photos" on storage.objects for all to public using (bucket_id = 'employee-photos') with check (bucket_id = 'employee-photos')$q$)
    ) as t(polname, ddl)
  loop
    begin
      execute format('drop policy if exists %I on storage.objects', r.polname);
      execute r.ddl;
    exception when others then
      raise notice 'storage policy % skipped (%): %', r.polname, sqlstate, sqlerrm;
    end;
  end loop;
end $do$;


-- ── VERIFY ─────────────────────────────────────────────────────────────────
-- 1. Six buckets, correct flags (board-backgrounds + employee-photos true):
--      select id, public from storage.buckets order by id;
--
-- 2. The 22 policies this file owns exist:
--      select policyname, cmd, roles from pg_policies
--       where schemaname='storage' and tablename='objects'
--         and policyname like 'Allow %' order by policyname;
--
-- 3. call-recordings has NO policy (expect 0):
--      select count(*) from pg_policies
--       where schemaname='storage' and tablename='objects' and qual like '%call-recordings%';
--
-- 4. THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL BUG — buckets exist at all:
--      select count(*) as buckets from storage.buckets;   -- must be >= 6, never 0
