-- ============================================================
-- Call recordings — SLICE B, PART 1: link a recording to a vehicle / RO.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHY THESE COLUMNS EXIST NOW, WITH NOTHING WRITING THEM YET:
--   The fleet case — "what did he say about THIS truck / THIS RO" — needs a
--   recording to be answerable WITHOUT re-deriving the link from the audio.
--   Adding the columns now means a later slice can backfill/populate them in
--   place; the play-button slice (B) neither writes nor reads them.
--
--   Both nullable, and NULL means "nobody has said yet" — NOT "no vehicle" /
--   "no RO". Never treat NULL as a negative fact.
--
-- SAFE TO RE-RUN: add column if not exists (idempotent). No RLS change — the
-- recordings table stays RLS-ENABLED with ZERO POLICIES (default-deny); only the
-- service-role key touches it. Slice B's reader is api/recording-links.js, which
-- uses the service-role key server-side and never exposes these columns.
-- ============================================================

alter table public.recordings
  add column if not exists vehicle_id uuid references public.vehicles(id),
  add column if not exists ro_id      uuid references public.repair_orders(id);

-- Lookups by vehicle / RO will come with the slice that populates them; index
-- now so that slice needs no schema change. Partial (only linked rows).
create index if not exists idx_recordings_vehicle_id
  on public.recordings (vehicle_id) where vehicle_id is not null;
create index if not exists idx_recordings_ro_id
  on public.recordings (ro_id) where ro_id is not null;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='recordings'
--       and column_name in ('vehicle_id','ro_id');   -- both uuid, YES nullable
--   -- RLS unchanged: still on, still zero policies:
--   select relrowsecurity from pg_class where oid='public.recordings'::regclass;         -- t
--   select count(*) from pg_policies where schemaname='public' and tablename='recordings'; -- 0
-- ============================================================
