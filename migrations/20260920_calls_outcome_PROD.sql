-- ============================================================================
-- Desk outcomes — replace the one destructive "Done" with four real outcomes.
-- PROD run (hygemiszxwmyrkmhbjub / www / board.leetransmissionshop.com).
-- -- Sandbox has its own file: 20260920_calls_outcome_SANDBOX.sql — RUN THAT ONE FIRST.
-- (identical except the inverted guard). Wiring: docs/wiring/call-window-desk.md §9.
--
-- WHY. The Desk's only way to clear a lane item was "Done" -> resolved_at: no confirm,
-- no undo, and no record of WHAT happened. Read-only prod audit 2026-09-20: of 40
-- resolved appointments, 22 were resolved within 60 SECONDS of being noted, by the same
-- person (fastest 3s, 5s, 6s) — mis-clicks, not "the car came in". One live casualty:
-- call id 755 (OMAR MADRID, due 2026-09-28) resolved 72s after MANNY PAGAN booked it.
--
-- WHAT THIS ADDS — three nullable columns on `calls`. NO NEW TABLE: a Desk appointment
-- IS a calls row (call-window-desk.md §1), an outcome is one more fact about that row,
-- and a side table would cost a join on every Desk render plus its own RLS for nothing.
--
--   outcome              which of the four things happened (CHECK-listed below).
--   outcome_note         the advisor's short reason ("no money till the 1st"). Optional.
--   outcome_prev_due_at  the drop-off date the lead could not make. Only 'not_now' sets it.
--
-- THE FOUR VALUES — and whether each one CLEARS the item:
--   'arrived'          drop-off: the car showed up             -> clears (resolved_at set)
--   'fixed_elsewhere'  drop-off: not coming, went elsewhere    -> clears (resolved_at set)
--   'not_now'          drop-off: can't right now (money/time)  -> DOES NOT CLEAR
--   'called'           Callbacks lane "Done" = I made the call -> clears
--
-- !! 'not_now' IS THE ONE OUTCOME THAT DOES NOT RESOLVE. The row stays OPEN and moves to
--    the Callbacks lane: next_step becomes 'quoted_callback', due_at becomes the call-back
--    date, outcome_prev_due_at keeps the drop-off date it missed, resolved_at stays NULL.
--    Do NOT "tidy" it into the resolved set — that would delete a live lead from the Desk,
--    which is the exact bug this migration exists to fix.
--
-- NO BACKFILL. Every existing row keeps outcome NULL. A row already resolved reads as
-- "old Done" — we genuinely do not know why it was cleared, so we do not invent a reason.
--
-- NO RLS CHANGE. anon already has SELECT + UPDATE on `calls` (slice 3a) and these columns
-- inherit it; row creation stays service-role/webhook-only. The security project is
-- separate and is not touched here.
--
-- Run BY HAND in the Supabase SQL editor — SANDBOX FIRST, then PROD.
-- Order vs the app: EITHER ORDER IS SAFE. deskLoad tries the wider select and falls back
-- to the old column list on 42703 (the same tier trick logLoad uses), so the board keeps
-- working with the plain "Done" until these columns exist.
--
-- SELF-GUARDING (staging-db.md §8.2/§8.3): the block refuses to run when app_env is empty
-- or says anything but PROD. Safe to re-run (add column if not exists; CHECK/index added only if missing).
-- ============================================================================

do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then
    raise exception 'app_env HAS NO ROW — STOP. Every guard would silently match nothing. Stamp this database first (staging-db.md §8).';
  end if;
  if v not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — this is the PROD file, refusing', v;
  end if;

  -- Three nullable columns, no defaults → metadata-only, no table rewrite.
  -- Existing table RLS covers them (anon already has SELECT + UPDATE on calls
  -- from slice 3a; row creation stays service-role only). No policy change.
  alter table public.calls
    add column if not exists outcome             text,
    add column if not exists outcome_note        text,
    add column if not exists outcome_prev_due_at timestamptz;

  comment on column public.calls.outcome is
    'What actually happened to this Desk item. NULL = cleared before outcomes existed ("old Done") or still open. One of shared/desk-outcomes.js OUTCOMES: arrived | fixed_elsewhere | not_now | called. NOTE not_now does NOT resolve the row — it moves it to the Callbacks lane as a live lead.';
  comment on column public.calls.outcome_note is
    'Short free-text reason the advisor typed ("no money till the 1st"). Optional.';
  comment on column public.calls.outcome_prev_due_at is
    'Only set by not_now: the drop-off date the lead could not make. That outcome rewrites due_at to the call-back date, so without this the callback row could not say why it is there.';

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.calls'::regclass
       and conname  = 'calls_outcome_check'
  ) then
    alter table public.calls
      add constraint calls_outcome_check
      check (outcome is null or outcome in ('arrived', 'fixed_elsewhere', 'not_now', 'called'));
  end if;

  -- "Recently cleared" reads resolved rows newest-first; partial so it stays small.
  create index if not exists idx_calls_resolved_at
    on public.calls (resolved_at desc)
    where resolved_at is not null;

  raise notice 'calls outcome columns added on %', v;
end $$;

notify pgrst, 'reload schema';

-- VERIFICATION (run after applying)
--   select env from public.app_env;                       -- the stamp for THIS file
--   -- 3 rows, all text/timestamptz, is_nullable = YES, no default:
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='calls'
--      and column_name in ('outcome','outcome_note','outcome_prev_due_at')
--    order by column_name;
--   -- 1 row, listing exactly the four values:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.calls'::regclass and conname='calls_outcome_check';
--   -- 1 row:
--   select indexname from pg_indexes
--    where schemaname='public' and tablename='calls' and indexname='idx_calls_resolved_at';
--   -- NOTHING is backfilled: set_count = 0. old_done = rows already resolved, which
--   -- keep outcome NULL forever (we do not know why they were cleared, so we do not guess):
--   select count(*) filter (where outcome is not null)                        as set_count,
--          count(*) filter (where resolved_at is not null and outcome is null) as old_done,
--          count(*)                                                            as all_calls
--     from public.calls;
--   -- What "Recently cleared" will list (last 30 days, OR still due in the future).
--   -- On PROD this is where id 755 (OMAR MADRID, due 2026-09-28, resolved 2026-09-08
--   -- by MANNY PAGAN) must appear — that is the Undo demo:
--   select id, caller_formatted, next_step, due_at, resolved_at, resolved_by_name, outcome
--     from public.calls
--    where resolved_at is not null
--      and (resolved_at >= now() - interval '30 days' or due_at >= now())
--    order by resolved_at desc;


-- ════════════════════════════════════════════════════════════════════════════
-- UNDO (not run). Drops the index, the CHECK and the three columns. Every outcome
-- recorded since is LOST, and any row parked in Callbacks by 'not_now' STAYS in
-- Callbacks (its next_step/due_at were really changed — only the reason is lost).
-- Deploy the app version without the outcome UI first, or it falls back to the
-- plain "Done" on its own (the 42703 tier), which is harmless.
--
--   drop index  if exists public.idx_calls_resolved_at;
--   alter table public.calls drop constraint if exists calls_outcome_check;
--   alter table public.calls
--     drop column if exists outcome,
--     drop column if exists outcome_note,
--     drop column if exists outcome_prev_due_at;
--   notify pgrst, 'reload schema';
-- ════════════════════════════════════════════════════════════════════════════
