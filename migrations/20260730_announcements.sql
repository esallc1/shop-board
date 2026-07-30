-- ============================================================
-- Announcement banner — v1: the `announcements` table.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   The owner broadcasts one short message to the office team, shown as a
--   dismissible banner on the office boards (advisor + owner). The board shows
--   the single most-recent ACTIVE, NON-EXPIRED announcement.
--
-- ⚠️ WRITES ARE SERVICE-ROLE ONLY (same posture as `calls`): anon may SELECT
--   (the banner reads with the board's anon key) but NOT insert/update/delete.
--   Posting/removing goes through api/announcement.js with the service-role key.
--   We do NOT widen anon writes here.
--
-- APPEND-ONLY: an announcement is never deleted. `removed_at` (null = active) is
--   stamped to retire it, mirroring the resolved_at / declined_at convention.
-- ============================================================

create table if not exists public.announcements (
  id             uuid primary key default gen_random_uuid(),
  message        text not null,
  style          text not null default 'normal',   -- 'normal' (info) | 'important' (alert)
  posted_by_name text,                              -- CHAT_IDENTITY.name of the poster
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,                       -- optional auto-hide; null = never expires
  removed_at     timestamptz,                       -- null = active; set = retired (append-only)
  constraint announcements_style_check check (style in ('normal', 'important'))
);

-- The banner's "current active" query: newest active row first.
create index if not exists idx_announcements_active
  on public.announcements (created_at desc) where removed_at is null;

alter table public.announcements enable row level security;

-- anon may SELECT only. No anon insert/update/delete — writes are service-role
-- (api/announcement.js), which bypasses RLS. Idempotent: drop first.
drop policy if exists "Allow anon select on announcements" on public.announcements;
create policy "Allow anon select on announcements"
  on public.announcements
  for select
  to anon
  using (true);

-- Realtime: tables created in the SQL Editor are NOT auto-added to the
-- supabase_realtime publication. Without this the banner never updates live.
-- Idempotent: guarded on pg_publication_tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'announcements'
  ) then
    alter publication supabase_realtime add table public.announcements;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='announcements' order by ordinal_position;
--   -- policies: SELECT only for anon, no insert/update/delete:
--   select policyname, cmd from pg_policies where tablename='announcements';
--   -- in the realtime publication:
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and schemaname='public' and tablename='announcements';  -- 1 row
-- ============================================================
