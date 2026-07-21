-- ============================================================
-- Team Chat — READ RECEIPTS ("seen"): put chat_reads on the realtime feed.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file.
--
-- WHY: read receipts flip live (✓ → ✓✓) via a realtime subscription on
-- chat_reads. Tables created in the SQL Editor are NOT auto-added to the
-- supabase_realtime publication (same lesson as todos / core_charges /
-- marketing_content), and no earlier migration added chat_reads — so without
-- this, receipts are still CORRECT on thread open (computed from a fresh
-- SELECT) but never flip live while both people have the thread open.
--
-- No schema change, no RLS change: chat_reads already has anon full-access RLS
-- (from 20260720_chat_reads.sql) so anon SELECT for the receipt computation is
-- already allowed. This only adds the table to the broadcast publication.
--
-- Idempotent: guarded on pg_publication_tables, so re-running is a no-op.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_reads'
  ) then
    alter publication supabase_realtime add table public.chat_reads;
  end if;
end $$;


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. chat_reads is now in the realtime publication.
-- select tablename from pg_publication_tables
-- where pubname='supabase_realtime' and schemaname='public' and tablename='chat_reads';  -- ⇒ 1 row
