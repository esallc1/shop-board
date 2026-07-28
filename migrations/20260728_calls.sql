-- ============================================================
-- CTM caller card — slice 2: the `calls` table (CrisData).
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- ctm_webhook_log (slice 1) is UNCHANGED.
--
-- One row per CTM call, keyed on the CTM call id. api/ctm-webhook.js UPSERTS
-- here (on conflict ctm_call_id do update) right after the ctm_webhook_log
-- insert, using the service-role key. The upsert is what makes CTM's retries
-- harmless and lets a future `end` trigger update the SAME row.
--
-- The advisor board subscribes to realtime INSERTs on this table and pops a
-- read-only caller card. It reads with the anon publishable key, so anon needs
-- SELECT — but nothing else. Writes are service-role only (bypass RLS).
-- ============================================================

create table if not exists public.calls (
  id                bigserial primary key,
  ctm_call_id       bigint not null unique,      -- body.id from CTM
  caller_bare       text,                        -- caller_number_bare (raw 10 digits)
  caller_formatted  text,                        -- caller_number_format ("(239) 600-1971")
  cnam              text,                        -- may be null / empty
  tracking_bare     text,                        -- tracking_number_bare
  source            text,                        -- body.source ("Direct")
  city              text,                        -- often empty string
  state             text,
  is_new_caller     boolean,
  tags              jsonb,                       -- body.tag_list (array, often empty)
  status            text,                        -- body.dial_status ("ringing")
  started_at        timestamptz,                 -- from body.unix_time (epoch seconds)
  created_at        timestamptz not null default now()
);

create index if not exists calls_started_at_idx on public.calls (started_at desc);

alter table public.calls enable row level security;

-- ONE policy: anon may SELECT, nothing else. (No anon insert/update/delete —
-- the webhook writes with the service-role key, which bypasses RLS.) Matches
-- the naming/shape of the repo's other board-readable anon policies; narrowed
-- from `for all` to `for select` because this table is board-READ-only.
-- Idempotent: no "create policy if not exists" in Postgres, so drop first.
drop policy if exists "Allow anon select on calls" on public.calls;
create policy "Allow anon select on calls"
  on public.calls
  for select
  to anon
  using (true);

-- Realtime: tables created in the SQL Editor are NOT auto-added to the
-- supabase_realtime publication (the todos / core_charges / chat_reads lesson).
-- Without this, the board's INSERT subscription never fires and no card pops.
-- Idempotent: guarded on pg_publication_tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table public.calls;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   -- table + policy
--   select policyname, cmd from pg_policies where tablename='calls';        -- ⇒ SELECT only
--   -- in the realtime publication
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and schemaname='public' and tablename='calls';  -- ⇒ 1 row
--   -- after a real test call to (239) 933-5750:
--   select ctm_call_id, caller_bare, caller_formatted, cnam, tracking_bare,
--          source, city, state, is_new_caller, tags, status, started_at
--     from public.calls order by started_at desc limit 5;
-- ============================================================
