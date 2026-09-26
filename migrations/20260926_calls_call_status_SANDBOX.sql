-- ============================================================================
-- Slice 4 — MISSED CALLS: calls.call_status + calls.ended_at (+ a one-time backfill).
-- ⛔ DO NOT RUN until Cris runs it by hand — sandbox first.
-- SANDBOX run (efhmefpaijjncwgbvwki / test.leetransmissionshop.com). Run this one FIRST;
-- the prod file is 20260926_calls_call_status_PROD.sql.
-- Wiring: docs/wiring/inbox-calls.md (missed calls), call-window-desk.md §1.
--
-- WHAT.
--   calls.call_status — CTM's end-of-call result: 'answered', 'no answer', 'busy', 'failed'
--                       (from the end / end_immediate webhooks' call_status — NOT dial_status,
--                       which says 'completed' on some missed calls). NULL = no end event yet.
--   calls.ended_at    — when CrisData got the end event.
--   Busy / failed / no answer = MISSED in the tray (red, top of "Needs handling").
--
-- WHO WRITES THEM. Only api/ctm-webhook.js (service role) — PATCH of these two columns by
--   positive ctm_call_id; never a new row, never the notes; 'answered' is never downgraded.
--   The browser never writes them. NO policy change here (the calls write lockdown —
--   20260926_calls_lockdown_* — is separate and covers these columns too).
--
-- BACKFILL (one time, this file): the last 30 days of end / end_immediate deliveries in
--   ctm_webhook_log → per positive CTM id: 'answered' if ANY end event said answered, else the
--   latest call_status; ended_at = the latest end delivery. Only rows whose call_status is still
--   NULL are touched, so re-running changes nothing. Desk "+ Add" rows (negative ids) never match.
--   NOTE: the UPDATE fires one realtime UPDATE per changed row — open advisor boards just redraw.
--
-- The code can ship before this runs: the board reads select('*') and the webhook logs and
--   carries on if the columns aren't there yet.
--
-- SELF-GUARDING (staging-db.md §8): refuses the wrong or an unstamped project.
-- One transaction: a failed guard aborts everything. Safe to re-run.
-- ============================================================================

begin;

do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then raise exception 'app_env HAS NO ROW — STOP. Stamp this database first (staging-db.md §8).'; end if;
  if v like 'PROD%' then raise exception 'WRONG PROJECT: % — this is the SANDBOX file, refusing', v; end if;
  if to_regclass('public.calls') is null then raise exception 'public.calls is missing — wrong database?'; end if;
  if to_regclass('public.ctm_webhook_log') is null then raise exception 'public.ctm_webhook_log is missing — wrong database?'; end if;
  raise notice 'calls call_status migration running on %', v;
end $$;

-- ── 1. The two columns ───────────────────────────────────────────────────────
alter table public.calls add column if not exists call_status text;
alter table public.calls add column if not exists ended_at    timestamptz;
comment on column public.calls.call_status is
  'CTM end-of-call result (answered / no answer / busy / failed) from the end webhooks'' call_status. '
  'NULL = no end event yet. Written ONLY by api/ctm-webhook.js; answered is never downgraded. Missed = not answered.';
comment on column public.calls.ended_at is
  'When CrisData received the end event for this call. Written ONLY by api/ctm-webhook.js.';

-- ── 2. One-time backfill: the last 30 days from ctm_webhook_log ─────────────
with ends as (
  select (body->>'id')::bigint                                                   as ctm_id,
         bool_or(body->>'call_status' = 'answered')                              as any_answered,
         (array_agg(body->>'call_status' order by received_at desc))[1]          as latest_status,
         max(received_at)                                                        as last_end_at
    from public.ctm_webhook_log
   where trigger_hint in ('end', 'end_immediate')
     and coalesce(body->>'call_status', '') <> ''
     and (body->>'id') ~ '^[0-9]+$'
     and received_at > now() - interval '30 days'
   group by 1
)
update public.calls c
   set call_status = case when e.any_answered then 'answered' else e.latest_status end,
       ended_at    = coalesce(c.ended_at, e.last_end_at)
  from ends e
 where c.ctm_call_id = e.ctm_id
   and c.ctm_call_id > 0
   and c.call_status is null;

commit;

-- ============================================================================
-- VERIFY (read-only; run right after, same SQL editor).
-- ============================================================================
-- 1. The columns are there:
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'calls' and column_name in ('call_status', 'ended_at');
--    → 2 rows: call_status text, ended_at timestamp with time zone
--
-- 2. What the backfill set (last 30 days), per status — expect mostly 'answered',
--    then 'no answer', a few 'busy' (Cris's Sept 24 prod count: 360 / 72 / 9 / 1 failed):
-- select coalesce(call_status, '(none yet)') as call_status, count(*) as calls,
--        min(started_at) as oldest, max(started_at) as newest
--   from public.calls
--  where ctm_call_id > 0 and started_at > now() - interval '30 days'
--  group by 1 order by 2 desc;
--
-- 3. Nothing touched a Desk "+ Add" row:
-- select count(*) as should_be_0 from public.calls where ctm_call_id <= 0 and (call_status is not null or ended_at is not null);

-- ============================================================================
-- UNDO (only if something breaks) — drops the two columns (and the backfilled values).
-- ============================================================================
-- begin;
-- alter table public.calls drop column if exists call_status;
-- alter table public.calls drop column if exists ended_at;
-- commit;
