-- ============================================================================
-- Desk — the KEY DROP BOX. One boolean on `calls`.
-- SANDBOX run (efhmefpaijjncwgbvwki / test.leetransmissionshop.com). RUN THIS ONE FIRST.
-- -- Prod has its own file: 20260921_calls_dropoff_key_box_PROD.sql (identical except the inverted guard).
-- Wiring: docs/wiring/call-window-desk.md §6b.
--
-- WHY. The shop has a key drop box at the front door; customers drop cars at 10 pm.
-- A drop-off's TIME mostly doesn't matter, but "it's in the box" does — the advisor
-- has to check the box in the morning. No existing column can carry it safely:
-- tags/status are CTM's (the webhook upsert overwrites them), note/outcome_note are
-- text people type, and a sentinel time would break the overdue rule + the calendar.
--
-- WHAT. calls.dropoff_key_box boolean NOT NULL DEFAULT false (constant default →
-- metadata-only, no table rewrite). Only meaningful when next_step = 'dropping_off';
-- stored WITH due_all_day = true (draws as an all-day chip + 🔑). No CHECK tying it
-- to due_all_day: dragging a chip to a timed slot clears it in the same write
-- (shared/desk-appointments.js reschedulePatch), and a CHECK would turn any path
-- that forgot into a failed save.
--
-- NO RLS CHANGE. anon already has SELECT + UPDATE on calls (slice 3a); the CTM
-- webhook upsert (merge-duplicates) only writes the columns it sends, so it never
-- touches this one. Order: DB FIRST, then code — though the board reads it in its
-- own select tier and never sends it to a DB that lacks it.
--
-- SELF-GUARDING (staging-db.md §8): refuses to run on the wrong project or an
-- unstamped one. Safe to re-run (add column if not exists).
-- ============================================================================

do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then raise exception 'app_env HAS NO ROW — STOP. Stamp this database first (staging-db.md §8).'; end if;
  if v like 'PROD%' then raise exception 'WRONG PROJECT: % — this is the SANDBOX file, refusing', v; end if;

  alter table public.calls add column if not exists dropoff_key_box boolean not null default false;
  comment on column public.calls.dropoff_key_box is
    'Drop-off via the front-door KEY DROP BOX (after hours). Only meaningful when next_step = dropping_off; stored with due_all_day = true (draws as an all-day chip + 🔑). Set/cleared only by the Desk + call window (shared/desk-appointments.js). call-window-desk.md §6b.';
  raise notice 'calls.dropoff_key_box added on %', v;
end $$;
notify pgrst, 'reload schema';

-- VERIFICATION (run after applying)
--   select env from public.app_env;
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='calls' and column_name='dropoff_key_box';
--   -- expect: boolean · NO · false
--   select count(*) filter (where dropoff_key_box) as key_box_rows, count(*) as all_calls from public.calls;
--   -- expect key_box_rows = 0
