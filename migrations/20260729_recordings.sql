-- ============================================================
-- Call recordings pipeline — SLICE A: get CTM call audio into Storage.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- WHAT THIS BACKS (no UI this slice):
--   • api/ctm-webhook.js — on the CTM `end` trigger, when the payload carries a
--     non-empty `audio` (a CTM API URL that 302-redirects to a TEMPORARY S3
--     link), inserts a `recordings` row with fetch_status='pending'. The
--     amazonaws.com URL is never stored — only the CTM API URL (remote_url),
--     always re-requested fresh.
--   • api/fetch-recordings.js — a 5-minute Vercel cron that downloads each
--     pending remote_url and uploads the bytes to the private `call-recordings`
--     bucket, then flips the row to 'ready' + storage_path.
--   • api/backfill-recordings.js — one-time, idempotent scan of ctm_webhook_log
--     (trigger_hint='end', body.audio present) to seed rows for calls already
--     logged (~40 from July 29).
--
-- ⚠️ RLS: ENABLED with ZERO POLICIES (default-deny). remote_url is a key to a
-- customer conversation and every board ships the same anon key, so the anon /
-- authenticated roles must NOT be able to read or write this table. ONLY the
-- server-side SERVICE-ROLE key (which bypasses RLS) touches `recordings` and the
-- `call-recordings` bucket. A reader (signed URL / policy) is Slice B — NOT here.
--
-- ctm_call_id is UNIQUE so the webhook + cron + backfill can all use
-- on-conflict-do-nothing: CTM retries and repeated `end` deliveries never create
-- a duplicate recording.
-- ============================================================

create table if not exists public.recordings (
  id               uuid primary key default gen_random_uuid(),
  source           text not null default 'call',      -- 'call' this slice; room for other sources later
  ctm_call_id      bigint unique,                      -- CTM body.id; UNIQUE → on-conflict-do-nothing
  call_id          bigint references public.calls(id) on delete set null,  -- resolved from calls.ctm_call_id; nullable
  remote_url       text not null,                      -- the CTM API URL (302→S3). NEVER the amazonaws.com url.
  storage_path     text,                               -- object key in the private call-recordings bucket, once fetched
  duration_seconds integer,                            -- from the payload's `duration`
  recorded_at      timestamptz,                        -- from the payload
  fetch_status     text not null default 'pending',    -- 'pending' | 'ready' | 'failed'
  fetch_attempts   integer not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The cron's work-list query: pending + under the attempt cap, oldest first.
create index if not exists idx_recordings_pending
  on public.recordings (fetch_status, created_at);
create index if not exists idx_recordings_call_id
  on public.recordings (call_id);

-- RLS on, NO policies → default-deny to anon/authenticated. Service-role only.
alter table public.recordings enable row level security;
-- (No CREATE POLICY on purpose. A Slice-B reader will add scoped access later.)

-- ============================================================
-- STORAGE — private 'call-recordings' bucket.
-- Cris may create this in the dashboard; this idempotent insert is here so the
-- cron never fails on a missing bucket. NO storage.objects policies are added
-- (private + service-role only), matching the zero-policy stance above.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', false)
on conflict (id) do nothing;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='recordings' order by ordinal_position;
--   -- RLS on, zero policies:
--   select relrowsecurity from pg_class where oid='public.recordings'::regclass;      -- t
--   select count(*) from pg_policies where schemaname='public' and tablename='recordings';  -- 0
--   select id, public from storage.buckets where id='call-recordings';               -- public=false
-- ============================================================
