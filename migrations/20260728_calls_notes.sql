-- ============================================================
-- Advisor call window — slice 3a: notes + next step on the caller card.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Extends `calls` (slice 2); ctm_webhook_log is UNCHANGED.
--
-- ⚠️ TYPE CORRECTION vs the task DDL: the task wrote
--   `customer_id bigint references customers(id)` and
--   `ro_id bigint references repair_orders(id)`,
-- but customers.id and repair_orders.id are BOTH `uuid` (gen_random_uuid),
-- not bigint — a bigint FK to a uuid PK fails to create. So these two FK
-- columns are `uuid`. (calls.id itself stays bigserial; only the FKs change.)
--
-- next_step is constrained with a CHECK (not an enum type) — same approach as
-- declined_at, so we never touch a shared enum.
-- ============================================================

alter table public.calls
  add column if not exists customer_id   uuid references public.customers(id),
  add column if not exists note          text,
  add column if not exists next_step     text,
  add column if not exists due_at        timestamptz,
  add column if not exists due_all_day   boolean default true,
  add column if not exists ro_id         uuid references public.repair_orders(id),
  add column if not exists noted_by_name text,
  add column if not exists noted_at      timestamptz;

-- next_step ∈ the four intake outcomes (NULL allowed = not yet chosen).
-- Idempotent: drop the constraint first so a re-run is clean.
alter table public.calls drop constraint if exists calls_next_step_check;
alter table public.calls
  add constraint calls_next_step_check
  check (next_step is null or next_step in
    ('quoted_callback', 'dropping_off', 'checking_on_car', 'price_shopper'));

-- ── RLS: calls was anon-SELECT-only (slice 2). The board now UPDATEs these
-- columns from the card, so add an anon UPDATE policy — matching the anon
-- posture of todos / marketing_content (using(true)/with check(true)). Row
-- CREATION stays service-role only: NO anon INSERT, NO anon DELETE policy, so
-- the webhook still owns inserts. Idempotent: drop first.
drop policy if exists "Allow anon update on calls" on public.calls;
create policy "Allow anon update on calls"
  on public.calls
  for update
  to anon
  using (true)
  with check (true);

-- ============================================================
-- VERIFY (run after applying):
--   -- columns present
--   select column_name, data_type from information_schema.columns
--     where table_name='calls'
--       and column_name in ('customer_id','note','next_step','due_at',
--                           'due_all_day','ro_id','noted_by_name','noted_at')
--     order by column_name;                                  -- ⇒ 8 rows (uuid FKs)
--   -- policies: SELECT + UPDATE for anon, NO insert/delete
--   select policyname, cmd from pg_policies where tablename='calls' order by cmd;
--   -- after a live test call + a typed note:
--   select ctm_call_id, customer_id, note, next_step, due_at, due_all_day,
--          ro_id, noted_by_name, noted_at
--     from public.calls order by started_at desc limit 5;
-- ============================================================
