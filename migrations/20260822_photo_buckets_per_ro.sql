-- ============================================================
-- PHOTO BUCKETS GO PER-RO — SLICE 3, SCHEMA + BACKFILL.
--
-- ⛔ THIS FILE IS THE **SANDBOX** RUN. It REFUSES TO RUN ON PROD.
--    Every block asserts `app_env NOT LIKE 'PROD%'`. The prod run gets its
--    OWN reviewed file (20260822_photo_buckets_per_ro_PROD.sql) — this one is
--    never "made safe for prod" by inverting a predicate, because a file whose
--    safety depends on somebody remembering to invert a predicate is not safe.
--    Sandbox = efhmefpaijjncwgbvwki.
--
-- RUN THE BLOCKS ONE AT A TIME, IN THE ORDER GIVEN. Look at each result before
-- running the next. Every block reports a COUNT, never "no rows returned".
--
-- ── WHAT CHANGES ──────────────────────────────────────────────────────
-- Buckets stop being shop-wide. A bucket now belongs to exactly ONE repair
-- order. A new RO is BORN with the shop's standard buckets COPIED onto it, and
-- from that moment nothing on the RO reaches back to a shared list: renaming or
-- removing a bucket on RO #6032 changes RO #6032 and nothing else, ever.
--
-- The shared list survives only as a TEMPLATE (`photo_bucket_templates`), read
-- exactly once per RO, by a trigger, at creation. It is not readable as "the
-- buckets" by anything at runtime — and `photo_buckets.ro_id NOT NULL` is what
-- makes "a bucket with no RO" unrepresentable rather than merely discouraged.
--
-- ── WHY THE ORDER IS A → B1 → C → B2 → B3 → B4 → B5 ───────────────────
-- The trigger (C) is created BEFORE the backfill (B2), not after it. On a live
-- database the shop keeps working while this runs, and `mintRo` can fire
-- mid-migration. With the trigger last there is a window between the backfill
-- and the trigger in which a new RO is born with NO buckets — and then B5's
-- `set not null` (or D's ros_with_no_bucket check) fails halfway through.
--
-- With C before B2 there is no such window:
--   • an RO created BEFORE C ................ caught by B2 (which covers ALL ROs)
--   • an RO created AFTER C ................. gets its buckets from the trigger
--   • an RO created BETWEEN them ............ both, and B2's ON CONFLICT no-ops
--
-- ── WHAT IS NOT DESTROYED ─────────────────────────────────────────────
-- No photo is touched except to REPOINT it at its own RO's copy of the same
-- bucket (B3), archived photos included, so history survives. The only rows
-- deleted anywhere are the two now-unreferenced shop-wide bucket rows in B4,
-- and that delete carries its own `not exists` proof.
-- ============================================================


-- ════════════════════════════════════════════════════════════════════════
-- 00. PRE-FLIGHT — RUN THIS FIRST. IT MUST PRINT A NOTICE, NOT AN ERROR.
--
--     ⚠️ WHY THIS BLOCK EXISTS. Every guard in this file tests
--     `(select env from public.app_env)`. If that table has NO ROW the
--     expression is NULL — and `NULL not like 'PROD%'` is NULL, not true. So
--     every DML block below would match ZERO rows, report `0`, and look for all
--     the world like it ran on a database with nothing to do.
--
--     That is precisely the failure staging-db.md §8.1 warns about: "an
--     environment with no stamp is worse than no guard at all", and "a check
--     that cannot fail loudly is not a check." A NULL guard fails SAFE (it
--     changes nothing) but SILENTLY, which is how a person concludes the
--     migration succeeded and moves on.
--
--     Reading app_env over PostgREST as `anon` returned zero rows on BOTH
--     projects on 2026-08-22. That is ambiguous — the table may genuinely be
--     unstamped, or RLS may be on with no anon policy while the SQL editor
--     (which bypasses RLS) sees the row perfectly well. THIS BLOCK SETTLES IT.
--     Run it and read the result:
--
--       • "app_env OK: <sandbox name>"  → the guard works. Continue to 0.
--       • "app_env HAS NO ROW"          → STOP. Stamp this database with the
--                                         block underneath, then re-run this.
--       • "WRONG PROJECT: PROD…"        → you are on prod. This file is not
--                                         for prod. Stop.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare v text;
begin
  select env into v from public.app_env limit 1;

  if v is null then
    raise exception
      'app_env HAS NO ROW in this database — STOP. Every guard in this migration would silently match nothing and report 0. Stamp this database first (staging-db.md §8.1), then re-run this block.';
  end if;

  if v like 'PROD%' then
    raise exception 'WRONG PROJECT: % — this file is the SANDBOX-ONLY run of slice 3, refusing', v;
  end if;

  raise notice 'app_env OK: % — guard is live, this is not prod.', v;
end $$;

-- ── ONLY IF 00 SAID "app_env HAS NO ROW" ────────────────────────────────
-- Stamp THIS database, then re-run block 00. The name is free text; it only
-- has to (a) exist and (b) not start with PROD. Do NOT run this on prod — prod
-- gets its own stamp, in its own session, with the exact prod string from
-- staging-db.md §8.
--
--   insert into public.app_env (env)
--   values ('SANDBOX — CrisData efhmefpaijjncwgbvwki')
--   on conflict do nothing
--   returning env;
--
-- ⚠️ AND SEPARATELY: if prod is also unstamped, that is a real gap and it is
--    NOT this migration's job to close. It is worth its own five minutes,
--    because the prod run of this slice depends on the same guard working
--    there. Flagged, not fixed here.


-- ════════════════════════════════════════════════════════════════════════
-- 0. SURVEY — READ-ONLY. Run this SECOND and look at the numbers.
--    `rows_backfill_will_create` is exactly what B2 should report.
--
--    SANDBOX, MEASURED 2026-08-22 (via PostgREST, before any of this ran):
--      ros = 54  ->  rows_backfill_will_create = 108
--      buckets_total = 2, buckets_live = 2  (Before / Part / Repair)
--      photos_total = 5, photos_live = 4, photos_bucketed = 5
--      ros_with_photos = 1   (every photo is on RO 2518bdd9…)
--    So the expected results below are: B1 -> 2, B2 -> 108, B3 -> 5, B4 -> 2.
-- ════════════════════════════════════════════════════════════════════════
select
  (select env from public.app_env)                                                           as env,
  (select count(*) from public.repair_orders)                                                as ros,
  (select count(*) from public.repair_orders) * 2                                            as rows_backfill_will_create,
  (select count(*) from public.photo_buckets)                                                as buckets_total,
  (select count(*) from public.photo_buckets where archived_at is null)                      as buckets_live,
  (select count(*) from public.attachments where kind = 'ro_photo')                           as photos_total,
  (select count(*) from public.attachments where kind = 'ro_photo' and deleted_at is null)    as photos_live,
  (select count(*) from public.attachments where kind = 'ro_photo' and bucket_id is not null) as photos_bucketed,
  (select count(distinct entity_id) from public.attachments where kind = 'ro_photo')          as ros_with_photos;


-- ════════════════════════════════════════════════════════════════════════
-- A. DDL — templates table, ro_id, archived_by, index swap.
--    Idempotent. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════
do $$
begin
  -- Refuses on PROD *and* on an unstamped database — see block 00. A NULL
  -- stamp must never be read as "not prod, carry on".
  if (select env from public.app_env) is null then
    raise exception 'app_env HAS NO ROW — refusing to run (see block 00)';
  end if;
  if (select env from public.app_env) like 'PROD%' then
    raise exception 'WRONG PROJECT: % — this file is the SANDBOX-ONLY run of slice 3, refusing',
      (select env from public.app_env);
  end if;

  -- A1. THE STANDARD SET. The only shop-wide list left, and it is read exactly
  -- once per RO, by the trigger in PART C, at creation. Nothing at runtime ever
  -- reads it — that is the difference between a COPY and a LINK.
  create table if not exists public.photo_bucket_templates (
    id         uuid primary key default gen_random_uuid(),
    name       text        not null,
    sort_order integer     not null default 0,
    created_at timestamptz not null default now()
  );
  -- Case-insensitive: names are free-typed, so 'Before' and 'before' are one name.
  create unique index if not exists photo_bucket_templates_name_idx
    on public.photo_bucket_templates (lower(name));

  -- A2. A bucket now BELONGS to one RO. Nullable for the length of this
  -- migration only — B5 sets it NOT NULL once every row has one.
  --
  -- ON DELETE CASCADE: a bucket must never outlive its RO. Largely theoretical
  -- (20260729_repair_orders_no_delete.sql removed the delete policy from
  -- repair_orders) but the rule belongs in the schema, not in a policy that a
  -- later migration could widen.
  alter table public.photo_buckets
    add column if not exists ro_id uuid references public.repair_orders(id) on delete cascade;

  -- A3. WHO removed it. `archived_at` already exists and already means
  -- "removed" — this is the missing half of that stamp, and it is deliberately
  -- NOT called removed_at/removed_by: one fact, one column. Same shape and
  -- meaning as attachments.deleted_by and chat_messages.deleted_by.
  alter table public.photo_buckets
    add column if not exists archived_by text;

  -- A4. Uniqueness moves from SHOP-WIDE to PER RO, and becomes
  -- case-insensitive. Still scoped to `archived_at is null`, for the same
  -- reason as slice 1: a plain unique would burn a name forever, so removing
  -- "Before" from an RO and later wanting it back would be impossible.
  drop index if exists public.photo_buckets_name_active_idx;
  create unique index if not exists photo_buckets_ro_name_active_idx
    on public.photo_buckets (ro_id, lower(name)) where archived_at is null;

  -- Postgres does not auto-index a foreign key column, and EVERY runtime read
  -- of this table is now "the buckets on RO X".
  create index if not exists idx_photo_buckets_ro_id
    on public.photo_buckets (ro_id);

  comment on column public.photo_buckets.ro_id is
    'The repair order this bucket BELONGS to. A bucket is a COPY made at RO creation, never a link to a shared list — renaming or removing it affects this RO only.';
  comment on column public.photo_buckets.archived_by is
    'Display NAME of whoever removed this bucket. Same meaning as attachments.deleted_by. Written from CHAT_IDENTITY.name read BARE — never window.CHAT_IDENTITY (dbc9f9a).';
  comment on table public.photo_bucket_templates is
    'The shop-wide STANDARD bucket set. Read exactly once per RO, by trg_repair_orders_photo_buckets, at creation. Nothing at runtime reads this table.';

  -- A5. RLS on the new table — BOTH roles. House rule: without the
  -- authenticated policy a logged-in office session is blinded to the table
  -- (office-auth.md §7). photo_buckets needs no policy change; its existing
  -- policies are table-level `using (true)`, so the new columns are covered.
  execute 'alter table public.photo_bucket_templates enable row level security';
  execute 'drop policy if exists "Allow anon full access to photo_bucket_templates" on public.photo_bucket_templates';
  execute 'create policy "Allow anon full access to photo_bucket_templates" on public.photo_bucket_templates for all to anon using (true) with check (true)';
  execute 'drop policy if exists "Allow authenticated full access to photo_bucket_templates" on public.photo_bucket_templates';
  execute 'create policy "Allow authenticated full access to photo_bucket_templates" on public.photo_bucket_templates for all to authenticated using (true) with check (true)';
end $$;

-- PostgREST caches the schema. Without this the first reads of the new table
-- and the new columns 400 until the cache refreshes on its own.
notify pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
-- B1. Seed the templates from the two live shop-wide buckets.
--     EXPECT 2 ROWS: Before (1), Part / Repair (2).
--     A result of 0 rows means the guard is NULL — go back to block 00.
-- ════════════════════════════════════════════════════════════════════════
insert into public.photo_bucket_templates (name, sort_order)
select b.name, b.sort_order
  from public.photo_buckets b
 where b.ro_id is null
   and b.archived_at is null
   and (select env from public.app_env) not like 'PROD%'   -- ← wrong project ⇒ 0 rows
on conflict (lower(name)) do nothing
returning id, name, sort_order;


-- ════════════════════════════════════════════════════════════════════════
-- C. THE TRIGGER — a new RO is BORN with the standard buckets on it.
--    RUN THIS BEFORE THE BACKFILL. See the ordering note in the header.
--
--    This lives in the DATABASE, not in mintRo, for three reasons:
--      1. mintRo already carries a resilient-insert retry that drops
--         service_writer_id and re-inserts. A second, separate write after it
--         can fail while the RO succeeds — leaving a bucketless RO while the
--         wizard says "RO #6041 created". A trigger is atomic with the insert.
--      2. It covers EVERY creation path, including hand-run SQL and any future
--         API route — not just the one call site that exists today.
--      3. mintRo therefore needs no change at all.
-- ════════════════════════════════════════════════════════════════════════
begin;

do $$
begin
  if (select env from public.app_env) is null then
    raise exception 'app_env HAS NO ROW — refusing to run (see block 00)';
  end if;
  if (select env from public.app_env) like 'PROD%' then
    raise exception 'WRONG PROJECT: % — sandbox-only, refusing', (select env from public.app_env);
  end if;
end $$;

-- Runs as the INVOKER (anon or authenticated). Both already carry full-access
-- policies on photo_bucket_templates (PART A5) and photo_buckets (slice 1), so
-- SECURITY DEFINER is not needed — and leaving it out means this trigger grants
-- nobody any privilege they did not already have.
create or replace function public.copy_photo_bucket_templates()
returns trigger
language plpgsql
as $fn$
begin
  insert into public.photo_buckets (ro_id, name, sort_order)
  select new.id, t.name, t.sort_order
    from public.photo_bucket_templates t
  on conflict do nothing;
  return null;                       -- AFTER trigger; the return value is ignored
end
$fn$;

comment on function public.copy_photo_bucket_templates() is
  'A new RO is BORN with the standard buckets COPIED onto it. A copy, not a link: after this fires nothing on the RO reads photo_bucket_templates again, so renaming or removing a bucket on one RO affects that RO alone.';

drop trigger if exists trg_repair_orders_photo_buckets on public.repair_orders;
create trigger trg_repair_orders_photo_buckets
  after insert on public.repair_orders
  for each row execute function public.copy_photo_bucket_templates();

commit;


-- ════════════════════════════════════════════════════════════════════════
-- B2. Backfill: copy both templates onto EVERY existing RO.
--     EXPECT `rows_backfill_will_create` from the survey (ros × 2). Sandbox: 108.
--     Re-runnable: ON CONFLICT DO NOTHING infers photo_buckets_ro_name_active_idx.
-- ════════════════════════════════════════════════════════════════════════
with ins as (
  insert into public.photo_buckets (ro_id, name, sort_order)
  select r.id, t.name, t.sort_order
    from public.repair_orders r
   cross join public.photo_bucket_templates t
   where (select env from public.app_env) not like 'PROD%'
  on conflict do nothing
  returning id
)
select count(*) as buckets_created from ins;


-- ════════════════════════════════════════════════════════════════════════
-- B3. Repoint every existing photo onto ITS OWN RO's copy of the same bucket.
--     EXPECT `photos_bucketed` from the survey. Sandbox: 5.
--
--     Archived photos (deleted_at not null) are repointed TOO, on purpose —
--     a tombstone that lost its bucket would come back wrong if it is ever
--     restored, and its history is the reason the row was kept at all.
-- ════════════════════════════════════════════════════════════════════════
with mapping as (
  select a.id as att_id, nb.id as new_bucket_id
    from public.attachments a
    join public.photo_buckets ob                       -- the old shop-wide bucket
      on ob.id = a.bucket_id and ob.ro_id is null
    join public.photo_buckets nb                       -- this RO's copy of it
      on nb.ro_id = a.entity_id
     and lower(nb.name) = lower(ob.name)
     and nb.archived_at is null
   where a.kind = 'ro_photo'
     and a.entity_type = 'repair_order'
), moved as (
  update public.attachments a
     set bucket_id = m.new_bucket_id
    from mapping m
   where a.id = m.att_id
     and (select env from public.app_env) not like 'PROD%'
  returning a.id
)
select count(*) as photos_repointed from moved;


-- ════════════════════════════════════════════════════════════════════════
-- B4. Delete the two now-unreferenced shop-wide bucket rows. EXPECT 2.
--
--     The `not exists` is INSIDE the delete, so if B3 missed anything this
--     removes nothing rather than orphaning a photo. A result of 0 or 1 means
--     STOP and re-check B3 — it does not mean "run it again".
-- ════════════════════════════════════════════════════════════════════════
with gone as (
  delete from public.photo_buckets b
   where b.ro_id is null
     and (select env from public.app_env) not like 'PROD%'
     and not exists (select 1 from public.attachments a where a.bucket_id = b.id)
  returning id, name
)
select count(*) as globals_deleted, coalesce(string_agg(name, ', '), '(none)') as names from gone;


-- ════════════════════════════════════════════════════════════════════════
-- B5. Lock the rule into the schema: ro_id NOT NULL.
--     Refuses, loudly, if anything is still orphaned.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare n_orphan bigint;
begin
  if (select env from public.app_env) is null then
    raise exception 'app_env HAS NO ROW — refusing to run (see block 00)';
  end if;
  if (select env from public.app_env) like 'PROD%' then
    raise exception 'WRONG PROJECT: % — sandbox-only, refusing', (select env from public.app_env);
  end if;

  select count(*) into n_orphan from public.photo_buckets where ro_id is null;
  if n_orphan > 0 then
    raise exception 'REFUSING: % bucket row(s) still have no ro_id — B3/B4 did not finish', n_orphan;
  end if;

  alter table public.photo_buckets alter column ro_id set not null;
end $$;

notify pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
-- D. VERIFY — ONE query, one column per check, COUNTS not emptiness.
--    Every *_must_be_0 column must read 0. Every *_expect_N must read N.
-- ════════════════════════════════════════════════════════════════════════
select
  (select env from public.app_env)                                                        as env,
  (select count(*) from public.photo_bucket_templates)                                    as templates_expect_2,
  (select count(*) from public.repair_orders)                                             as ros,
  (select count(*) from public.photo_buckets)                                             as buckets,
  (select count(*) from public.photo_buckets where ro_id is null)                         as buckets_orphan_must_be_0,
  (select count(*) from public.repair_orders r
     where not exists (select 1 from public.photo_buckets b where b.ro_id = r.id))        as ros_with_no_bucket_must_be_0,
  (select count(*) from public.attachments where kind = 'ro_photo')                        as photos,
  (select count(*) from public.attachments a
     where a.kind = 'ro_photo' and a.bucket_id is not null
       and not exists (select 1 from public.photo_buckets b
                        where b.id = a.bucket_id and b.ro_id = a.entity_id))              as photos_off_their_own_ro_must_be_0,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'photo_buckets'
       and column_name in ('ro_id', 'archived_by'))                                       as new_cols_expect_2,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'photo_buckets'
       and column_name = 'ro_id' and is_nullable = 'NO')                                  as ro_id_not_null_expect_1,
  (select count(*) from pg_indexes where schemaname = 'public'
       and indexname = 'photo_buckets_ro_name_active_idx')                                as per_ro_unique_idx_expect_1,
  (select count(*) from pg_indexes where schemaname = 'public'
       and indexname = 'photo_buckets_name_active_idx')                                   as old_global_idx_must_be_0,
  (select count(*) from pg_trigger where tgrelid = 'public.repair_orders'::regclass
       and tgname = 'trg_repair_orders_photo_buckets')                                    as trigger_expect_1,
  (select count(*) from pg_policies where schemaname = 'public'
       and tablename = 'photo_bucket_templates')                                          as template_policies_expect_2;


-- ════════════════════════════════════════════════════════════════════════
-- E. PROVE THE TRIGGER FIRES. Sandbox only — rolls itself back.
--    EXPECT buckets_expect_2 = 2.
--
--    ⚠️ Burns one value from the ro_number identity sequence. Sequences do not
--    roll back, so the next real sandbox RO skips a number. Harmless there.
--    DO NOT run this variant on prod — the prod file proves the trigger by
--    inspecting the first RO the shop creates naturally instead.
-- ════════════════════════════════════════════════════════════════════════
begin;
  with src as (select customer_id, vehicle_id from public.repair_orders limit 1),
       new_ro as (
         insert into public.repair_orders (customer_id, vehicle_id)
         select customer_id, vehicle_id from src
         returning id, ro_number
       )
  select n.ro_number,
         (select count(*) from public.photo_buckets b where b.ro_id = n.id) as buckets_expect_2
    from new_ro n;
rollback;


-- ════════════════════════════════════════════════════════════════════════
-- F. PROVE THE RULES. Read-only-by-rollback; keeps nothing. Run as ONE block.
--    EXPECT: dupe_blocked = t, cross_ro_same_name_ok = t.
-- ════════════════════════════════════════════════════════════════════════
begin;
  -- (1) The same name is legal on TWO DIFFERENT ROs — that is the whole point.
  -- (2) A duplicate name on the SAME RO is rejected by the partial index.
  select
    (select count(*) from public.photo_buckets b
      join (select id from public.repair_orders limit 2) r on r.id = b.ro_id
     where lower(b.name) = 'before' and b.archived_at is null) = 2 as cross_ro_same_name_ok,
    (select not exists (
       select 1 from public.photo_buckets b1
       join public.photo_buckets b2
         on b1.ro_id = b2.ro_id and b1.id <> b2.id
        and lower(b1.name) = lower(b2.name)
        and b1.archived_at is null and b2.archived_at is null)) as dupe_blocked;
rollback;
