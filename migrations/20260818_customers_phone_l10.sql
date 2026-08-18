-- ============================================================
-- Auto-attach — the last-10 phone lookup key on `customers`.
-- Run BY HAND. SANDBOX FIRST (efhmefpaijjncwgbvwki). Do NOT run on prod until
-- the feature ships there.
-- Additive only: two GENERATED columns + two indexes. No data is rewritten by
-- hand, nothing is dropped, no policy changes (the existing table-level
-- `using (true)` policies cover new columns automatically).
--
-- WHY THIS EXISTS
-- `customers.phone_primary` / `phone_secondary` are stored AS TYPED — the
-- sandbox holds values like "(786) 531-5419" next to "8135909459". The
-- backfills coped by computing the key inline:
--     right(regexp_replace(coalesce(phone_primary,''), '\D', '', 'g'), 10)
-- which is fine for a one-shot sequential scan over ~2,700 rows, but the
-- going-forward path needs a DIFFERENT thing: the CTM webhook has to look a
-- caller up by that key, per call, through PostgREST — and PostgREST cannot
-- filter on a function expression. A bare functional index would be unusable
-- from the API for exactly that reason.
--
-- So the key becomes a real, stored, indexed column. Two consequences worth
-- having:
--   1. PostgREST can filter it directly:
--        /customers?select=id&or=(phone_primary_l10.eq.8135909459,
--                                 phone_secondary_l10.eq.8135909459)
--   2. The DEFINITION of the key now lives in the database, in the same
--      expression the backfill SQL used and that shared/call-auto-attach.js
--      mirrors (last10Key). Live and backfill cannot drift apart by accident.
--
-- SAFETY NOTES
-- • GENERATED ALWAYS ... STORED columns are computed by Postgres and cannot be
--   written by the app. Nothing in the repo does `select('*')` on customers and
--   writes the row back (every customers write is an explicit narrow patch —
--   `{ phone_secondary: ... }` — so there is no path that could try to assign
--   one of these and error).
-- • Adding a stored generated column rewrites the table and takes a brief
--   ACCESS EXCLUSIVE lock. At ~2,700 customer rows that is effectively instant.
-- • The empty string is the value for "no phone on file". Both indexes are
--   PARTIAL (`where <> ''`) so the thousands of blank secondaries never enter
--   the index — and '' can never be a lookup key anyway, because
--   isJunkNumber() rejects anything that is not exactly 10 digits.
-- ============================================================

begin;

alter table public.customers
  add column if not exists phone_primary_l10 text
    generated always as (right(regexp_replace(coalesce(phone_primary, ''), '\D', '', 'g'), 10)) stored,
  add column if not exists phone_secondary_l10 text
    generated always as (right(regexp_replace(coalesce(phone_secondary, ''), '\D', '', 'g'), 10)) stored;

comment on column public.customers.phone_primary_l10 is
  'Generated: last 10 digits of phone_primary. The auto-attach lookup key. Read-only — Postgres maintains it.';
comment on column public.customers.phone_secondary_l10 is
  'Generated: last 10 digits of phone_secondary. The auto-attach lookup key. Read-only — Postgres maintains it.';

create index if not exists customers_phone_primary_l10_idx
  on public.customers (phone_primary_l10)
  where phone_primary_l10 <> '';

create index if not exists customers_phone_secondary_l10_idx
  on public.customers (phone_secondary_l10)
  where phone_secondary_l10 <> '';

commit;

-- PostgREST caches the schema; make it pick the new columns up immediately
-- (otherwise the first webhook lookups 400 until the cache refreshes on its own).
notify pgrst, 'reload schema';

-- ── VERIFY ──────────────────────────────────────────────────────────────
-- 1. The columns exist and are generated:
--      select column_name, is_generated, generation_expression
--        from information_schema.columns
--       where table_schema='public' and table_name='customers'
--         and column_name like 'phone_%_l10';
--
-- 2. The key is correct for a known messy row (expect 7865315419):
--      select name, phone_primary, phone_primary_l10
--        from public.customers where phone_primary_l10 = '7865315419';
--
-- 3. THE INDEX IS ACTUALLY BEING USED — this is the one that matters. Run:
--      set enable_seqscan = on;                      -- don't fake it
--      explain (analyze, buffers)
--        select id from public.customers
--         where phone_primary_l10 = '8135909459'
--            or phone_secondary_l10 = '8135909459';
--
--    WANT: a `Bitmap Heap Scan on customers` fed by
--          `BitmapOr` -> two `Bitmap Index Scan`s naming
--          customers_phone_primary_l10_idx / customers_phone_secondary_l10_idx.
--    A single-column probe (`where phone_primary_l10 = '...'`) should show a
--    plain `Index Scan using customers_phone_primary_l10_idx`.
--
--    IF YOU SEE `Seq Scan`: at ~2,700 rows the planner may legitimately decide a
--    seq scan is cheaper — that is not a failure, it is a small table. Confirm
--    the index is usable rather than unused by forcing it:
--      set enable_seqscan = off;
--      explain select id from public.customers where phone_primary_l10 = '8135909459';
--      reset enable_seqscan;
--    If it names the index under that setting, the index is correct and the
--    planner will switch to it as the table grows. Run `analyze public.customers;`
--    first if the plan looks like it is guessing.
