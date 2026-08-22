-- ============================================================
-- PHOTO BUCKETS GO PER-RO — SLICE 3. ⚠️ THIS IS THE **PRODUCTION** FILE.
--
-- Sibling: migrations/20260822_photo_buckets_per_ro.sql — the SANDBOX run,
-- applied and verified green on efhmefpaijjncwgbvwki on 2026-08-22.
-- These are two separate reviewed files ON PURPOSE. Neither is turned into the
-- other by inverting a predicate: a file whose safety depends on somebody
-- remembering to flip a `not like` is not safe. This one REFUSES unless
-- app_env starts with PROD; that one refuses if it does.
--
-- ════════════════════════════════════════════════════════════════════════
-- ⛔ READ ALL FOUR BEFORE YOU RUN ANYTHING
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. RUN THIS AFTER HOURS, WITH NOBODY SHOOTING PHOTOS.
--    Not because of lock duration — this is small and fast. Because of a
--    WINDOW between the migration and the code deploy:
--
--    The moment B2 lands there are TWO bucket rows named "Before" for every
--    RO in the shop. The CURRENTLY DEPLOYED My Numbers builds a shop-wide
--    `name -> id` map (`PHOTO_BUCKETS[b.name]`, last one wins) and looks up
--    the literal 'Before'. With per-RO rows that lookup returns an ARBITRARY
--    RO's bucket — so a tech who uploads a photo in that window files it onto
--    SOMEBODY ELSE'S REPAIR ORDER, silently, with no error.
--
--    => The migration and the code deploy are ONE maintenance window.
--       Migrate, deploy, verify. Do not migrate on Friday and deploy Monday.
--
-- 2. NO DATA-MODIFYING CTEs. Every count below comes from a DO block using
--    GET DIAGNOSTICS, never `with x as (insert …) select count(*)`.
--    WHY: the Supabase SQL editor's linter reads `with x as (insert into
--    public.repair_orders …)` as a CREATE TABLE and throws a dialog whose
--    GREEN DEFAULT BUTTON is "Run and enable RLS". One click would ENABLE RLS
--    ON repair_orders — every board reads it through the anon key, so that is
--    a shop-wide blackout. Tripped on the sandbox 2026-08-22 and cancelled.
--    See docs/wiring/staging-db.md §8.4.
--
-- 3. THE ENV GUARD IS ONLY REAL IN THE SQL EDITOR. `app_env` has RLS on with
--    no anon policy, so a REST read returns "no rows" on a correctly stamped
--    database. Block 00 must be run HERE, in the editor. staging-db.md §8.3.
--
-- 4. ORDER IS A -> B1 -> C -> B2 -> B3 -> B4 -> B5. The TRIGGER (C) IS
--    CREATED BEFORE THE BACKFILL (B2), and that is not cosmetic. The shop is
--    live; mintRo can fire mid-migration. With the trigger last there is a
--    window in which a new RO is born with NO buckets, and then B5's SET NOT
--    NULL fails halfway through. With C before B2 there is no such window:
--      • an RO created BEFORE C ........ caught by B2 (which covers ALL ROs)
--      • an RO created AFTER C ......... gets its buckets from the trigger
--      • one created BETWEEN them ...... both; B2's ON CONFLICT no-ops
--
-- RUN THE BLOCKS ONE AT A TIME. Read each NOTICE before running the next.
-- Every block reports a COUNT, never "no rows returned".
-- ============================================================


-- ════════════════════════════════════════════════════════════════════════
-- 00. PRE-FLIGHT — RUN FIRST. MUST PRINT A NOTICE, NOT AN ERROR.
--     "app_env HAS NO ROW"  -> STOP. Prod is unstamped. Stamp it in its own
--                              session with the exact string from
--                              staging-db.md §8, then re-run this.
--     "WRONG PROJECT"       -> you are NOT on prod. This file is prod-only.
--     "app_env OK: PROD…"   -> continue to 0.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare v text;
begin
  select env into v from public.app_env limit 1;

  if v is null then
    raise exception
      'app_env HAS NO ROW in this database — STOP. Every guard in this migration would silently match nothing and report 0. Stamp prod first (staging-db.md §8), then re-run this block.';
  end if;

  if v not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — this is the PRODUCTION file, refusing. Use 20260822_photo_buckets_per_ro.sql for the sandbox.', v;
  end if;

  raise notice 'app_env OK: % — this IS prod. Proceed only inside the maintenance window.', v;
end $$;


-- ════════════════════════════════════════════════════════════════════════
-- 0. SURVEY — READ-ONLY. Run second. Write these numbers down:
--    B1 should report 2, B2 should report `rows_backfill_will_create`,
--    B3 should report `photos_bucketed`, B4 should report 2.
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
-- A. DDL — templates table, ro_id, archived_by, index swap. Idempotent.
-- ════════════════════════════════════════════════════════════════════════
do $$
begin
  if (select env from public.app_env) is null then
    raise exception 'app_env HAS NO ROW — refusing to run (see block 00)';
  end if;
  if (select env from public.app_env) not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — PRODUCTION file, refusing', (select env from public.app_env);
  end if;

  -- A1. The standard set. The only shop-wide list left, read exactly ONCE per
  -- RO, by the trigger in PART C, at creation. Nothing at runtime reads it.
  create table if not exists public.photo_bucket_templates (
    id         uuid primary key default gen_random_uuid(),
    name       text        not null,
    sort_order integer     not null default 0,
    created_at timestamptz not null default now()
  );
  create unique index if not exists photo_bucket_templates_name_idx
    on public.photo_bucket_templates (lower(name));

  -- A2. A bucket now BELONGS to one RO. Nullable for the length of this
  -- migration only — B5 sets it NOT NULL once every row has one.
  alter table public.photo_buckets
    add column if not exists ro_id uuid references public.repair_orders(id) on delete cascade;

  -- A3. The missing half of the removal stamp. NOT called removed_at/removed_by:
  -- archived_at already exists and already means "removed" — one fact, one
  -- column. Same shape as attachments.deleted_by.
  alter table public.photo_buckets
    add column if not exists archived_by text;

  -- A4. Uniqueness moves shop-wide -> per RO, and becomes case-insensitive
  -- (names are free-typed now). Still scoped to live buckets, so removing
  -- "Before" from an RO does not burn the name on that RO forever.
  drop index if exists public.photo_buckets_name_active_idx;
  create unique index if not exists photo_buckets_ro_name_active_idx
    on public.photo_buckets (ro_id, lower(name)) where archived_at is null;

  create index if not exists idx_photo_buckets_ro_id
    on public.photo_buckets (ro_id);

  comment on column public.photo_buckets.ro_id is
    'The repair order this bucket BELONGS to. A bucket is a COPY made at RO creation, never a link to a shared list — renaming or removing it affects this RO only.';
  comment on column public.photo_buckets.archived_by is
    'Display NAME of whoever removed this bucket. Same meaning as attachments.deleted_by. Written from CHAT_IDENTITY.name read BARE — never window.CHAT_IDENTITY (dbc9f9a).';
  comment on table public.photo_bucket_templates is
    'The shop-wide STANDARD bucket set. Read exactly once per RO, by trg_repair_orders_photo_buckets, at creation. Nothing at runtime reads this table.';

  -- A5. RLS on the new table — BOTH roles (house rule; office-auth §7).
  -- photo_buckets needs no policy change: its policies are table-level
  -- `using (true)`, so the new columns are covered automatically.
  execute 'alter table public.photo_bucket_templates enable row level security';
  execute 'drop policy if exists "Allow anon full access to photo_bucket_templates" on public.photo_bucket_templates';
  execute 'create policy "Allow anon full access to photo_bucket_templates" on public.photo_bucket_templates for all to anon using (true) with check (true)';
  execute 'drop policy if exists "Allow authenticated full access to photo_bucket_templates" on public.photo_bucket_templates';
  execute 'create policy "Allow authenticated full access to photo_bucket_templates" on public.photo_bucket_templates for all to authenticated using (true) with check (true)';

  raise notice 'A: DDL applied.';
end $$;

notify pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
-- B1. Seed the templates from the two live shop-wide buckets.
--     EXPECT 2 ROWS: Before (1), Part / Repair (2).
--     Plain INSERT … RETURNING — no CTE. The returned rows ARE the report.
-- ════════════════════════════════════════════════════════════════════════
insert into public.photo_bucket_templates (name, sort_order)
select b.name, b.sort_order
  from public.photo_buckets b
 where b.ro_id is null
   and b.archived_at is null
   and (select env from public.app_env) like 'PROD%'      -- wrong project => 0 rows
on conflict (lower(name)) do nothing
returning id, name, sort_order;


-- ════════════════════════════════════════════════════════════════════════
-- C. THE TRIGGER — a new RO is BORN with the standard buckets on it.
--    RUN THIS BEFORE THE BACKFILL. See note 4 in the header.
--
--    In the DATABASE, not in mintRo, for three reasons:
--      1. mintRo already carries a resilient-insert retry that drops
--         service_writer_id and re-inserts. A second, separate write after it
--         can fail while the RO succeeds — a bucketless RO while the wizard
--         says "RO #6041 created". A trigger is atomic with the insert.
--      2. It covers EVERY creation path — comebacks, the legacy 5xxx PO
--         override, hand-run SQL, and any future API route. A repo sweep on
--         2026-08-22 found exactly ONE app path (mintRo); the trigger keeps
--         that irrelevant.
--      3. mintRo therefore needs no change at all.
-- ════════════════════════════════════════════════════════════════════════
begin;

do $$
begin
  if (select env from public.app_env) is null then
    raise exception 'app_env HAS NO ROW — refusing to run (see block 00)';
  end if;
  if (select env from public.app_env) not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — PRODUCTION file, refusing', (select env from public.app_env);
  end if;
end $$;

-- Runs as the INVOKER (anon or authenticated). Both already hold full-access
-- policies on photo_bucket_templates (A5) and photo_buckets (slice 1), so
-- SECURITY DEFINER is not needed — this trigger grants nobody anything new.
create or replace function public.copy_photo_bucket_templates()
returns trigger
language plpgsql
as $fn$
begin
  insert into public.photo_buckets (ro_id, name, sort_order)
  select new.id, t.name, t.sort_order
    from public.photo_bucket_templates t
  on conflict do nothing;
  return null;                       -- AFTER trigger; return value is ignored
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
--     EXPECT `rows_backfill_will_create` from the survey (ros × 2).
--     DO block + GET DIAGNOSTICS — no data-modifying CTE.
--     Re-runnable: ON CONFLICT infers photo_buckets_ro_name_active_idx.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare n bigint;
begin
  if (select env from public.app_env) is null then
    raise exception 'app_env HAS NO ROW — refusing to run (see block 00)';
  end if;
  if (select env from public.app_env) not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — PRODUCTION file, refusing', (select env from public.app_env);
  end if;

  insert into public.photo_buckets (ro_id, name, sort_order)
  select r.id, t.name, t.sort_order
    from public.repair_orders r
   cross join public.photo_bucket_templates t
  on conflict do nothing;

  get diagnostics n = row_count;
  raise notice 'B2: buckets_created = %  (expect ros x 2 from block 0)', n;
end $$;


-- ════════════════════════════════════════════════════════════════════════
-- B3. Repoint every existing photo onto ITS OWN RO's copy of the same bucket.
--     EXPECT `photos_bucketed` from the survey.
--
--     UPDATE … FROM with a join, not a CTE. Archived photos (deleted_at not
--     null) are repointed TOO, on purpose: a tombstone that lost its bucket
--     would come back wrong if it is ever restored, and its history is the
--     reason the row was kept at all.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare n bigint;
begin
  if (select env from public.app_env) is null then
    raise exception 'app_env HAS NO ROW — refusing to run (see block 00)';
  end if;
  if (select env from public.app_env) not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — PRODUCTION file, refusing', (select env from public.app_env);
  end if;

  update public.attachments a
     set bucket_id = nb.id
    from public.photo_buckets ob,          -- the old shop-wide bucket
         public.photo_buckets nb           -- this RO's copy of it
   where a.kind = 'ro_photo'
     and a.entity_type = 'repair_order'
     and ob.id = a.bucket_id
     and ob.ro_id is null
     and nb.ro_id = a.entity_id
     and lower(nb.name) = lower(ob.name)
     and nb.archived_at is null;

  get diagnostics n = row_count;
  raise notice 'B3: photos_repointed = %  (expect photos_bucketed from block 0)', n;
end $$;


-- ════════════════════════════════════════════════════════════════════════
-- B4. Delete the two now-unreferenced shop-wide bucket rows. EXPECT 2.
--
--     The `not exists` is INSIDE the delete, so if B3 missed anything this
--     removes nothing rather than orphaning a photo. A count of 0 or 1 means
--     STOP and re-check B3 — it does NOT mean run it again.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare n bigint; names text;
begin
  if (select env from public.app_env) is null then
    raise exception 'app_env HAS NO ROW — refusing to run (see block 00)';
  end if;
  if (select env from public.app_env) not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — PRODUCTION file, refusing', (select env from public.app_env);
  end if;

  select string_agg(b.name, ', ') into names
    from public.photo_buckets b
   where b.ro_id is null
     and not exists (select 1 from public.attachments a where a.bucket_id = b.id);

  delete from public.photo_buckets b
   where b.ro_id is null
     and not exists (select 1 from public.attachments a where a.bucket_id = b.id);

  get diagnostics n = row_count;
  raise notice 'B4: globals_deleted = % (%)  — expect 2', n, coalesce(names, '(none)');
end $$;


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
  if (select env from public.app_env) not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — PRODUCTION file, refusing', (select env from public.app_env);
  end if;

  select count(*) into n_orphan from public.photo_buckets where ro_id is null;
  if n_orphan > 0 then
    raise exception 'REFUSING: % bucket row(s) still have no ro_id — B3/B4 did not finish', n_orphan;
  end if;

  alter table public.photo_buckets alter column ro_id set not null;
  raise notice 'B5: ro_id is now NOT NULL.';
end $$;

notify pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
-- D. VERIFY — ONE query, one column per check, COUNTS not emptiness.
--    Every *_must_be_0 must read 0. Every *_expect_N must read N.
--    ⚠️ ALSO DEPLOY THE CODE NOW, IN THIS SAME WINDOW — see header note 1.
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
-- E. PROVE THE TRIGGER FIRES — WITHOUT INSERTING A ROW.
--
--    ⚠️ The sandbox file proves this by inserting an RO inside a transaction
--    and rolling back. DO NOT DO THAT ON PROD: the ro_number identity sequence
--    does NOT roll back, so it would burn a customer-visible RO number, and
--    the insert-in-a-CTE form is what tripped the "enable RLS" dialog.
--
--    On prod the trigger is proved by the FIRST RO the shop creates naturally.
--    Run this after the next real RO is written; expect has_buckets = 2.
-- ════════════════════════════════════════════════════════════════════════
select r.ro_number,
       r.created_at,
       (select count(*) from public.photo_buckets b where b.ro_id = r.id) as has_buckets_expect_2
  from public.repair_orders r
 order by r.created_at desc
 limit 1;


-- ════════════════════════════════════════════════════════════════════════
-- F. ROLLBACK NOTE — what is and is not reversible.
--
--    REVERSIBLE with no data loss: A, B2, B5. Drop the NOT NULL, delete the
--    per-RO bucket rows, drop the trigger, function, index and columns.
--
--    NOT CLEANLY REVERSIBLE: B4 deletes the two shop-wide bucket rows. If you
--    need to go back AFTER B4, re-create them and re-point the photos:
--
--      insert into public.photo_buckets (name, sort_order) values
--        ('Before', 1), ('Part / Repair', 2);
--      -- then repoint each photo to the global row matching its bucket's name
--
--    So: if anything looks wrong, STOP BEFORE B4. Everything up to B3 is
--    additive — the old global buckets are still there and the old code still
--    works against them.
-- ════════════════════════════════════════════════════════════════════════
