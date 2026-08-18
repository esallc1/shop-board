-- ============================================================
-- Customer merge — the SCHEMA half. Run BY HAND.
-- SANDBOX FIRST (efhmefpaijjncwgbvwki). Not on prod until a slice has been
-- watched working on the sandbox.
--
-- Additive only: 3 nullable columns on `customers` + 1 new table + 2 indexes.
-- No data is changed here. Nothing is dropped. Existing RLS on `customers` is
-- table-level `using (true)`, so the new columns are covered automatically.
--
-- WHY A LOG TABLE AND NOT RUN-ID COLUMNS ON THE HOT TABLES
-- `merged_into` records THAT a customer was merged; it does not record WHICH
-- child rows moved. Without that you cannot un-merge — a loser who already
-- shared a vehicle with the keeper is indistinguishable afterwards. The
-- alternative, stamping a run id on vehicles / repair_orders / calls /
-- customer_phones, means four columns on four hot tables. One log table gives
-- more (per-CLUSTER undo, not just per-run, plus a permanent audit trail) and
-- touches nothing else.
--
-- See docs/wiring/customer-dedupe.md §8.
-- ============================================================

begin;

-- ── customers: the archive marks ──────────────────────────────────────
alter table public.customers
  add column if not exists merged_into   uuid references public.customers(id),
  add column if not exists archived_at   timestamptz,
  add column if not exists merge_run_id  uuid;

comment on column public.customers.merged_into is
  'The surviving customer this row was merged into. NULL for a live record.';
comment on column public.customers.archived_at is
  'Set when this row was merged away. Every SEARCH/MATCH read excludes it; a read BY ID still returns it so the record page can point at the survivor.';
comment on column public.customers.merge_run_id is
  'Which merge run archived this row. The run-level undo key.';

-- Partial: only archived rows are ever looked up this way.
create index if not exists customers_merged_into_idx
  on public.customers (merged_into) where merged_into is not null;

-- ── the undo log ──────────────────────────────────────────────────────
-- One row per child row repointed. run_id groups a batch; cluster_id groups one
-- keeper+losers set, so a single bad cluster can be reversed without touching
-- the others in the same run.
create table if not exists public.customer_merge_log (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid        not null,
  cluster_id        uuid        not null,
  table_name        text        not null,   -- 'vehicles' | 'repair_orders' | 'calls' | 'interactions' | 'customer_phones' | 'customers'
  -- TEXT, not uuid, on purpose: `calls.id` is a BIGSERIAL while every other
  -- table here keys on uuid. One log table has to hold both, so the id is
  -- stored as text and cast back at reverse time (`l.row_id = t.id::text`).
  row_id            text        not null,
  from_customer_id  uuid,                   -- NULL on the 'customers' archive row
  to_customer_id    uuid,
  demoted_primary   boolean     not null default false,  -- customer_phones only: its is_primary was cleared to dodge the partial-unique index
  moved_at          timestamptz not null default now(),
  note              text
);

create index if not exists customer_merge_log_run_idx     on public.customer_merge_log (run_id);
create index if not exists customer_merge_log_cluster_idx on public.customer_merge_log (cluster_id);

-- ── RLS ───────────────────────────────────────────────────────────────
-- HOUSE RULE: a NEW table gets BOTH {anon} AND {authenticated} full access,
-- mirroring `customers`. Without the authenticated policy a logged-in office
-- session is blinded to the table (see office-auth.md §7).
alter table public.customer_merge_log enable row level security;

drop policy if exists "Allow anon full access to customer_merge_log" on public.customer_merge_log;
create policy "Allow anon full access to customer_merge_log"
  on public.customer_merge_log for all to anon using (true) with check (true);

drop policy if exists "Allow authenticated full access to customer_merge_log" on public.customer_merge_log;
create policy "Allow authenticated full access to customer_merge_log"
  on public.customer_merge_log for all to authenticated using (true) with check (true);

commit;

notify pgrst, 'reload schema';

-- ── VERIFY ────────────────────────────────────────────────────────────
-- 1. Columns exist:
--      select column_name, data_type from information_schema.columns
--       where table_schema='public' and table_name='customers'
--         and column_name in ('merged_into','archived_at','merge_run_id');
--
-- 2. BOTH policies exist on the new table (expect 2 rows, roles {anon} and
--    {authenticated}, cmd ALL):
--      select policyname, cmd, roles from pg_policies
--       where schemaname='public' and tablename='customer_merge_log';
--
-- 3. Nothing has been archived yet (expect 0):
--      select count(*) from public.customers where archived_at is not null;
