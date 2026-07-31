-- ============================================================
-- Requests & Feedback intake — Phase 1: the `change_requests` table.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   The inbound counterpart to the announcement banner. Kevin (Manager),
--   Josh (Advisor) and Bookkeeping submit a Bug/Idea — text and/or an uploaded
--   screenshot — from their own board (a "🚩 Report a change" button in the
--   topbar). The owner triages it from the owner board's "Team Comms" tab
--   (New -> Reviewing -> In progress -> Done / Not now / Won't build) and writes
--   a neutral status note back (owner_note). See docs/wiring/change-requests.md.
--
-- ⚠️ WRITES ARE SERVICE-ROLE ONLY (same posture as `announcements` / `calls`):
--   anon may SELECT (the boards read the triage/list with the anon key) but NOT
--   insert/update/delete. Submitting and triaging go through
--   api/change-request.js with the service-role key. We do NOT widen anon writes.
--
-- SCREENSHOTS reuse the EXISTING private `crisdata-attachments` bucket under a
--   `reports/<uuid>/<file>` prefix (uploaded client-side with the anon key, read
--   via short-lived createSignedUrl) — same trust boundary as invoice images and
--   chat/todo attachments. No new storage bucket or storage policy is needed.
-- ============================================================

create table if not exists public.change_requests (
  id                uuid primary key default gen_random_uuid(),
  type              text not null,                    -- 'bug' | 'idea'
  priority          text not null default 'normal',   -- 'immediate' | 'high' | 'normal' | 'low' (the To-Do scale)
  body              text,                             -- the plain note (nullable; a submission can be screenshot-only)
  screenshot_path   text,                             -- pointer inside crisdata-attachments (reports/<uuid>/<file>); nullable
  screenshot_name   text,                             -- original filename (chip/alt display)
  screenshot_mime   text,                             -- content type
  submitted_by_id   uuid,                             -- employees.id of the submitter (nullable — identity may be unresolved)
  submitted_by_name text,                             -- CHAT_IDENTITY.name of the submitter
  submitted_by_role text,                             -- role inferred from which board it was sent from (a hint, not a boundary)
  context_board     text,                             -- which board: 'manager' | 'advisor' | 'bookkeeping'
  context_view      text,                             -- the active tab/screen (.sidebar-item.active dataset.view)
  context_ro        text,                             -- RO # if one was in scope; nullable
  app_version       text,                             -- deployed build SHA from /api/version at submit time
  user_agent        text,                             -- navigator.userAgent (device/browser)
  status            text not null default 'new',      -- 'new' | 'reviewing' | 'in_progress' | 'done' | 'not_now' | 'wont_build'
  owner_note        text,                             -- latest neutral note back to the submitter (denormalized; surfaced Phase 2)
  owner_note_at     timestamptz,                      -- when owner_note was last written
  created_at        timestamptz not null default now(),

  constraint change_requests_type_check     check (type in ('bug', 'idea')),
  constraint change_requests_priority_check check (priority in ('immediate', 'high', 'normal', 'low')),
  constraint change_requests_status_check   check (status in ('new', 'reviewing', 'in_progress', 'done', 'not_now', 'wont_build')),
  -- must carry SOMETHING: a non-blank note OR a screenshot (mirrors the
  -- endpoint's "body OR screenshot required" rule).
  constraint change_requests_has_content    check (
    (body is not null and length(btrim(body)) > 0) or screenshot_path is not null
  )
);

-- Triage list: open items first, newest first. Plus a submitter index for the
-- Phase 2 client-side "My requests" filter.
create index if not exists idx_change_requests_status     on public.change_requests (status);
create index if not exists idx_change_requests_created     on public.change_requests (created_at desc);
create index if not exists idx_change_requests_submitter   on public.change_requests (submitted_by_id);

alter table public.change_requests enable row level security;

-- anon may SELECT only. No anon insert/update/delete — writes are service-role
-- (api/change-request.js), which bypasses RLS. Idempotent: drop first.
drop policy if exists "Allow anon select on change_requests" on public.change_requests;
create policy "Allow anon select on change_requests"
  on public.change_requests
  for select
  to anon
  using (true);

-- Realtime: tables created in the SQL Editor are NOT auto-added to the
-- supabase_realtime publication. Without this the triage list never updates
-- live. Idempotent: guarded on pg_publication_tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'change_requests'
  ) then
    alter publication supabase_realtime add table public.change_requests;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='change_requests' order by ordinal_position;
--   -- policies: SELECT only for anon, no insert/update/delete:
--   select policyname, cmd from pg_policies where tablename='change_requests';
--   -- in the realtime publication:
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and schemaname='public' and tablename='change_requests';  -- 1 row
--   -- content constraint rejects an empty submission:
--   insert into public.change_requests (type) values ('bug');   -- should FAIL (has_content)
-- ============================================================
