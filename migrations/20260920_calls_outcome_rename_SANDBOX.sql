-- ============================================================================
-- Desk outcomes — RENAME two values. SANDBOX ONLY (efhmefpaijjncwgbvwki / test.*).
--
-- THERE IS NO _PROD TWIN, AND THERE MUST NOT BE. Prod has never run
-- 20260920_calls_outcome_PROD.sql, so prod has no outcome column and nothing to
-- rename — that file was edited in place and already carries the final four values.
-- This file exists only because the SANDBOX ran the earlier draft and now holds
-- rows with the old strings. Running it against prod would fail the guard below
-- anyway.
--
-- WHY THE RENAME (Cris, 2026-09-20). The first cut used 'fixed_elsewhere' and
-- 'not_now'. Both name ONE reason, and the buttons above them said the same — so the
-- first car that fixed itself, or customer who sold theirs, would have been filed
-- under "fixed elsewhere", and every report from then on would have repeated it.
-- The buttons now say WHAT HAPPENED and the note says WHY:
--
--   'fixed_elsewhere'  ->  'not_coming'   button "Not coming"  (still clears the item)
--   'not_now'          ->  'follow_up'    button "Follow up"   (still does NOT clear)
--
-- 'arrived' and 'called' are unchanged. outcome_note / outcome_prev_due_at are not
-- touched: the reasons people typed stay exactly as typed.
--
-- ORDER MATTERS HERE (unlike the first migration, which was safe either way):
--   RUN THIS **BEFORE** loading the renamed board, or immediately after.
-- The old CHECK still lists the old strings, so the new board's writes would fail
-- with 23514 check_violation — a visible "Could not save" alert, not silent data
-- loss, and reads keep working. This is a CHECK mismatch, not a missing column, so
-- the board's 42703 fallback does NOT cover it. There is no in-between state where
-- anything is written wrong.
--
-- SELF-GUARDING (staging-db.md §8.2/§8.3): refuses to run when app_env is empty or
-- says PROD. Safe to re-run — the UPDATEs match nothing the second time and the
-- constraint swap is guarded.
-- ============================================================================

do $$
declare v text; n_fixed int; n_now int;
begin
  select env into v from public.app_env limit 1;
  if v is null then
    raise exception 'app_env HAS NO ROW — STOP. Every guard would silently match nothing. Stamp this database first (staging-db.md §8).';
  end if;
  if v like 'PROD%' then
    raise exception 'WRONG PROJECT: % — this file is SANDBOX-ONLY (prod never ran the old values), refusing', v;
  end if;

  -- 1. Drop the old CHECK first, or the remap below cannot write the new strings.
  alter table public.calls drop constraint if exists calls_outcome_check;

  -- 2. Remap. Nothing else changes — same rows, same lanes, same notes.
  update public.calls set outcome = 'not_coming' where outcome = 'fixed_elsewhere';
  get diagnostics n_fixed = row_count;
  update public.calls set outcome = 'follow_up'  where outcome = 'not_now';
  get diagnostics n_now = row_count;

  -- 3. Put the CHECK back with the final four values.
  alter table public.calls
    add constraint calls_outcome_check
    check (outcome is null or outcome in ('arrived', 'not_coming', 'follow_up', 'called'));

  comment on column public.calls.outcome is
    'What actually happened to this Desk item. NULL = cleared before outcomes existed ("old Done") or still open. One of shared/desk-outcomes.js OUTCOMES: arrived | not_coming | follow_up | called. NOTE follow_up does NOT resolve the row — it moves it to the Callbacks lane as a live lead.';
  comment on column public.calls.outcome_prev_due_at is
    'Only set by follow_up: the drop-off date the lead could not make. That outcome rewrites due_at to the call-back date, so without this the callback row could not say why it is there.';

  raise notice 'renamed on %: fixed_elsewhere->not_coming = %, not_now->follow_up = %', v, n_fixed, n_now;
end $$;

notify pgrst, 'reload schema';

-- VERIFICATION (run after applying)
--   select env from public.app_env;                      -- must NOT say PROD
--   -- 1 row, listing exactly arrived / not_coming / follow_up / called:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.calls'::regclass and conname='calls_outcome_check';
--   -- no old strings survive  ⇒ both counts 0:
--   select count(*) filter (where outcome = 'fixed_elsewhere') as old_fixed_elsewhere,
--          count(*) filter (where outcome = 'not_now')         as old_not_now
--     from public.calls;
--   -- what each value now holds. Expect (from the 2026-09-20 verification rows):
--   --   not_coming = 3  (ids 286, 287, 288)   called = 1  (id 290)
--   --   follow_up  = 1  (id 289 — and its resolved_at MUST still be null)
--   select outcome, count(*), count(*) filter (where resolved_at is null) as still_open
--     from public.calls where outcome is not null group by outcome order by outcome;
--   -- the parked lead is still a LIVE lead, in Callbacks, with its reason intact:
--   select id, next_step, due_at, resolved_at, outcome, outcome_note, outcome_prev_due_at
--     from public.calls where id = 289;


-- ════════════════════════════════════════════════════════════════════════════
-- UNDO (not run). Puts the old strings and the old CHECK back — only useful if
-- we also roll the board back to a commit before the rename.
--
--   alter table public.calls drop constraint if exists calls_outcome_check;
--   update public.calls set outcome = 'fixed_elsewhere' where outcome = 'not_coming';
--   update public.calls set outcome = 'not_now'         where outcome = 'follow_up';
--   alter table public.calls add constraint calls_outcome_check
--     check (outcome is null or outcome in ('arrived','fixed_elsewhere','not_now','called'));
--   notify pgrst, 'reload schema';
-- ════════════════════════════════════════════════════════════════════════════
