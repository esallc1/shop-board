-- ============================================================
-- Announcement banner — audience targeting. Adds `audience` to `announcements`.
-- Run in the Supabase SQL Editor AFTER 20260730_announcements.sql. Cris runs
-- migrations by hand; the app never runs this.
--
-- WHAT THIS BACKS:
--   "Who sees it" — an announcement targets any combo of the three office roles
--   (manager / advisor / bookkeeping). Each role board shows only announcements
--   whose audience includes its role:
--     manager      -> gm-board.html
--     advisor      -> advisor-board.html
--     bookkeeping  -> bookkeeping-board.html
--   The owner board shows the active one unfiltered (a broadcaster preview) and
--   is where announcements are posted. Tech-floor screens are excluded entirely.
--
-- `audience` is a text[] of role keys. DEFAULT all three, so any pre-existing
-- (pre-audience) row keeps showing to everyone. NOT NULL — the app always sends
-- at least one role (the endpoint rejects an empty audience).
--
-- SAFE TO RE-RUN: add column if not exists (idempotent). No RLS change — reads
-- stay anon SELECT; writes stay service-role (api/announcement.js).
-- ============================================================

alter table public.announcements
  add column if not exists audience text[] not null
    default array['manager', 'advisor', 'bookkeeping'];

-- Role-filtered "current active" query uses array containment (audience @>
-- ARRAY[<role>]); a GIN index serves it.
create index if not exists idx_announcements_audience
  on public.announcements using gin (audience);

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='announcements' and column_name='audience';
--     -- ARRAY, NO (not null), default {manager,advisor,bookkeeping}
--   -- role-filtered read (what the advisor board runs):
--   select id, message, audience from public.announcements
--    where removed_at is null and (expires_at is null or expires_at > now())
--      and audience @> array['advisor']
--    order by created_at desc limit 1;
-- ============================================================
