-- ============================================================
-- Marketing Content — "Catch this moment" captures + Cris's
-- consolidated marketing library. Run in the Supabase SQL Editor
-- (project hygemiszxwmyrkmhbjub). ADDITIVE ONLY.
--
-- Storage rule: photos + SHORT capture clips live in Supabase (small);
-- big/polished marketing videos live on YouTube (unlisted) and we store
-- only the LINK (+ thumbnail derived from the id). So a row is either:
--   storage='file'    → file_path in the private marketing-content bucket
--   storage='youtube' → youtube_url (no file)
--
-- Idempotent; the app has fallbacks so nothing breaks pre-migration.
-- ============================================================

create table if not exists public.marketing_content (
  id uuid primary key default gen_random_uuid(),
  media_type text not null check (media_type in ('photo', 'video')),
  storage    text not null check (storage in ('file', 'youtube')),
  file_path   text,          -- set when storage='file' (bucket object path)
  youtube_url text,          -- set when storage='youtube'
  caption     text,
  captured_by text,          -- CHAT_IDENTITY.name (same as core returns)
  captured_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_marketing_content_captured_at on public.marketing_content (captured_at desc);
create index if not exists idx_marketing_content_media_type on public.marketing_content (media_type);

-- RLS: anon-full-access, matching core_charges / invoice_queue (no
-- Supabase Auth; access is app-level).
alter table public.marketing_content enable row level security;
drop policy if exists "Allow anon full access to marketing_content" on public.marketing_content;
create policy "Allow anon full access to marketing_content"
  on public.marketing_content for all to anon using (true) with check (true);

-- Realtime — so "catch this moment" captures appear live in the owner
-- Marketing tab. (SQL-Editor tables aren't auto-added.)
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='marketing_content'
  ) then
    alter publication supabase_realtime add table public.marketing_content;
  end if;
end $$;

-- ============================================================
-- STORAGE: private 'marketing-content' bucket. Objects live under
-- photos/<yyyy-mm>/ and clips/<yyyy-mm>/. Access via short-lived signed
-- URLs (createSignedUrl), same as invoice-images. Anon insert + select +
-- delete (owner deletes a stored item's object before its row).
-- Honest caveat (same as invoice-images): "private" = not globally
-- guessable via a permanent public URL, NOT per-role access control.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('marketing-content', 'marketing-content', false)
on conflict (id) do nothing;

drop policy if exists "Allow anon insert to marketing-content" on storage.objects;
create policy "Allow anon insert to marketing-content"
  on storage.objects for insert to anon with check (bucket_id = 'marketing-content');

drop policy if exists "Allow anon read marketing-content" on storage.objects;
create policy "Allow anon read marketing-content"
  on storage.objects for select to anon using (bucket_id = 'marketing-content');

drop policy if exists "Allow anon delete marketing-content" on storage.objects;
create policy "Allow anon delete marketing-content"
  on storage.objects for delete to anon using (bucket_id = 'marketing-content');


-- ============================================================
-- VERIFY (run after applying):
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='marketing_content';
--   select id, public from storage.buckets where id='marketing-content';   -- public=false
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and tablename='marketing_content'; -- 1 row
-- ============================================================
