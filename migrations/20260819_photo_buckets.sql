-- ============================================================
-- Photo buckets — SLICE 1, SCHEMA ONLY. No UI in this migration.
-- Run BY HAND. ✅ SANDBOX FIRST (efhmefpaijjncwgbvwki). ❌ NOT on prod.
--
-- ⚠️ RUN IN TWO STEPS, IN THIS ORDER. PART A IS ITS OWN STATEMENT.
--    PART A is `alter type ... add value`. Run it ALONE first, let it finish,
--    THEN run PART B. Do not paste both at once.
--
--    WHY: `ALTER TYPE ... ADD VALUE` has a transaction restriction that varies
--    by Postgres major version —
--      • PG < 12  — it CANNOT run inside a transaction block at all. Pasting it
--                   with PART B errors: "ALTER TYPE ... ADD VALUE cannot run
--                   inside a transaction block".
--      • PG >= 12 — it CAN run inside a transaction, but the new value cannot be
--                   USED until that transaction has committed.
--    Splitting it is correct on EVERY version, so the version question stops
--    mattering. This is also exactly how this repo already did it:
--    migrations/20260717_ro_diagnosis.sql adds 'diagnosis_audio' as a bare
--    statement above its transaction, with the same warning.
--
--    (Nothing here USES 'ro_photo' — PART B only adds a column and seeds bucket
--    names — so even on PG >= 12 a single transaction would have worked. The
--    split costs nothing and removes the failure mode.)
--
-- ADDITIVE ONLY: 1 new table + 2 seed rows + 1 nullable column + 2 indexes +
-- 1 enum value + RLS on the NEW table only. No DROP of any table/column/index,
-- no UPDATE, no DELETE, no change to an existing policy, no data rewritten.
--
-- NAME UNIQUENESS IS SCOPED TO ACTIVE BUCKETS (partial unique index), not the
-- whole table — so archiving "Before" does not burn the name forever. Decided
-- up front on purpose: changing it after slice 1 ships would cost a hand-run
-- migration on BOTH projects.
--
-- WHAT THIS IS FOR
-- Photos attach to a REPAIR ORDER and are sorted into buckets the shop names
-- itself. Techs shoot them from My Numbers. Today those grids
-- (`renderPhotoGrid`, my-numbers.html) are LOCAL ONLY — data URLs in a
-- localStorage draft, never uploaded, invisible to the office. This schema is
-- what lets them become real. Seeded with the two names techs already see, so
-- day one looks identical to them.
--
-- WHY NO NEW STORAGE BUCKET
-- Photos reuse the existing PRIVATE `crisdata-attachments` bucket at
-- `repair_order/<ro_id>/photos/<ts>.<ext>` — mirroring the diagnosis-audio path
-- that already works (my-numbers.html uploadClip). Its storage.objects policies
-- already cover anon AND authenticated. A new bucket would mean a MANUAL
-- dashboard step on BOTH projects (buckets are not created by migration on
-- staging — see docs/wiring/staging-db.md Step 4a), so we avoid one.
-- ============================================================


-- ════════════════════════════════════════════════════════════════════════
-- PART A — RUN THIS LINE BY ITSELF, FIRST. NOT inside a transaction.
-- Adds the 'ro_photo' value to the attachment_kind enum. `if not exists`
-- makes it re-runnable. Enum values cannot be removed in Postgres, so this
-- is additive and permanent by nature.
-- ════════════════════════════════════════════════════════════════════════

alter type public.attachment_kind add value if not exists 'ro_photo';


-- ════════════════════════════════════════════════════════════════════════
-- PART B — run this AFTER Part A has committed. One transaction.
-- ════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. photo_buckets — the shop-named categories ──────────────────────
-- Modelled on public.expense_categories (the existing precedent for a
-- user-named, reorderable list), plus archived_at.
--
-- archived_at is how a bucket is REMOVED. The bucket row is never deleted, so
-- `attachments.bucket_id` stays valid and the photos keep their history — the
-- bucket simply stops being offered. "Nothing is ever deleted" holds for the
-- bucket as well as the photo.
create table if not exists public.photo_buckets (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,              -- unique among ACTIVE buckets only, see below
  sort_order  integer     not null default 0,
  archived_at timestamptz,                       -- set = removed from the picker
  created_at  timestamptz not null default now()
);

-- UNIQUE ON ACTIVE BUCKETS ONLY — deliberately NOT an inline `unique` on name.
-- A plain unique constraint spans archived rows too, so archiving "Before" would
-- permanently burn the name: the shop could never have a "Before" bucket again.
-- Scoping uniqueness to `archived_at is null` means at most ONE live bucket may
-- hold a given name, while any number of archived ones may keep it in history.
-- This MUST be created before the seed below — ON CONFLICT infers this index.
create unique index if not exists photo_buckets_name_active_idx
  on public.photo_buckets (name) where archived_at is null;

comment on table public.photo_buckets is
  'Shop-named photo categories for RO photos. Renameable, reorderable, and removable by ARCHIVING (archived_at) — never by delete, so attachments.bucket_id stays valid.';
comment on column public.photo_buckets.archived_at is
  'Set when the shop removes this bucket. Archived buckets are hidden from pickers; their photos keep pointing here and keep their history.';
comment on column public.photo_buckets.sort_order is
  'Display order in the picker and on the customer record. Lower first.';

-- ── 2. Seed the two names techs already see ───────────────────────────
-- Exactly two rows, matching the hardcoded grids in my-numbers.html
-- ('Before Photos' / 'Part / Repair Photos') so day one looks identical.
-- ON CONFLICT so a re-run is a no-op rather than a unique violation.
--
-- The conflict target MUST carry the index predicate — `(name) where archived_at
-- is null` — so it infers photo_buckets_name_active_idx above. A bare
-- `on conflict (name)` would find no matching unique index and error with
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification". Inferring a PARTIAL unique index this way has been supported
-- since PostgreSQL 9.5, so there is no version in play here where it fails.
-- These rows leave archived_at NULL, so they fall inside the index and inference
-- applies. (An ARCHIVED 'Before' would NOT conflict — which is the point.)
insert into public.photo_buckets (name, sort_order) values
  ('Before',        1),
  ('Part / Repair', 2)
on conflict (name) where archived_at is null do nothing;

-- ── 3. attachments.bucket_id — nullable = "No bucket" ─────────────────
-- NULL is a real, expected state, not a missing value: it IS "No bucket".
-- Removing a photo from a bucket sets this to NULL; the photo row and the
-- storage object are untouched.
--
-- ON DELETE SET NULL: if a bucket row is ever hard-deleted (the normal path is
-- archived_at, but this guarantees the rule at the DB level), its photos fall
-- back to "No bucket" instead of the delete failing or cascading. A photo can
-- never be destroyed by a bucket operation.
--
-- No DEFAULT and no NOT NULL, so this is a catalog-only change — Postgres does
-- NOT rewrite the attachments table. Existing rows (diagnosis_audio) get NULL.
alter table public.attachments
  add column if not exists bucket_id uuid references public.photo_buckets(id) on delete set null;

comment on column public.attachments.bucket_id is
  'Which photo bucket this attachment sits in. NULL = "No bucket" — a real state, not missing data. Only meaningful for kind = ''ro_photo''.';

-- Postgres does not auto-index a foreign key column. This index serves both
-- "show me everything in bucket X" and the ON DELETE SET NULL scan.
-- Partial: only bucketed rows are ever looked up this way, and every existing
-- attachments row (and every future audio clip) is NULL here.
create index if not exists idx_attachments_bucket_id
  on public.attachments (bucket_id) where bucket_id is not null;

-- ── 4. RLS on the NEW table only ──────────────────────────────────────
-- HOUSE RULE: a new table gets BOTH {anon} AND {authenticated} full access.
-- Without the authenticated policy a logged-in office session is blinded to
-- the table (office-auth.md §7).
--
-- `attachments` needs NO policy change: it already carries `for all to anon`
-- (20260716_ro_foundation.sql) and `for all to authenticated`
-- (20260801_office_auth_widen_step1_5.sql). Both are TABLE-level `using (true)`
-- — not column-scoped — so the new bucket_id column is covered automatically.
alter table public.photo_buckets enable row level security;

drop policy if exists "Allow anon full access to photo_buckets" on public.photo_buckets;
create policy "Allow anon full access to photo_buckets"
  on public.photo_buckets for all to anon using (true) with check (true);

drop policy if exists "Allow authenticated full access to photo_buckets" on public.photo_buckets;
create policy "Allow authenticated full access to photo_buckets"
  on public.photo_buckets for all to authenticated using (true) with check (true);

commit;

-- PostgREST caches the schema. Without this the first reads of photo_buckets
-- and attachments.bucket_id 400 until the cache refreshes on its own.
notify pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
-- VERIFY — all read-only. Run after PART B.
-- ════════════════════════════════════════════════════════════════════════
-- 1. The enum gained 'ro_photo' (expect id_photo, walkaround, tax_cert,
--    diagnosis_audio, ro_photo):
--      select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
--       where t.typname = 'attachment_kind' order by e.enumsortorder;
--
-- 2. The table and its columns:
--      select column_name, data_type, is_nullable, column_default
--        from information_schema.columns
--       where table_schema = 'public' and table_name = 'photo_buckets'
--       order by ordinal_position;
--
-- 3. Exactly two seed rows, in order (expect Before / Part / Repair, both
--    archived_at NULL):
--      select name, sort_order, archived_at from public.photo_buckets
--       order by sort_order;
--
-- 3b. Uniqueness is PARTIAL — scoped to active buckets (expect one row whose
--     indexdef ends in `WHERE (archived_at IS NULL)`, and NO plain unique
--     constraint on name):
--      select indexname, indexdef from pg_indexes
--       where schemaname='public' and tablename='photo_buckets';
--      select conname, contype from pg_constraint
--       where conrelid = 'public.photo_buckets'::regclass order by contype;
--
-- 3c. PROVE the rule (safe, fully reversed by its own rollback — run as ONE
--     block; it archives the seeded Before, re-adds an active Before, then
--     puts everything back exactly as it was):
--      begin;
--        update public.photo_buckets set archived_at = now() where name='Before';
--        insert into public.photo_buckets (name, sort_order) values ('Before', 1);
--        select name, sort_order, archived_at from public.photo_buckets
--         where name='Before';          -- expect 2 rows: one archived, one live
--      rollback;                        -- nothing is kept
--
-- 4. attachments gained a NULLABLE bucket_id (expect uuid, YES):
--      select column_name, data_type, is_nullable
--        from information_schema.columns
--       where table_schema = 'public' and table_name = 'attachments'
--         and column_name = 'bucket_id';
--
-- 5. The FK exists and is ON DELETE SET NULL (expect delete_rule = SET NULL):
--      select tc.constraint_name, rc.delete_rule
--        from information_schema.table_constraints tc
--        join information_schema.referential_constraints rc
--          on rc.constraint_name = tc.constraint_name
--       where tc.table_schema = 'public' and tc.table_name = 'attachments'
--         and tc.constraint_type = 'FOREIGN KEY';
--
-- 6. BOTH policies exist on the new table (expect 2 rows, roles {anon} and
--    {authenticated}, cmd ALL):
--      select policyname, cmd, roles from pg_policies
--       where schemaname = 'public' and tablename = 'photo_buckets';
--
-- 7. Both new indexes exist (expect idx_attachments_bucket_id and
--    photo_buckets_name_active_idx):
--      select tablename, indexname from pg_indexes
--       where schemaname = 'public'
--         and indexname in ('idx_attachments_bucket_id','photo_buckets_name_active_idx')
--       order by tablename;
--
-- 8. NOTHING changed for existing data — every existing attachment is
--    unbucketed and still audio (expect one row: diagnosis_audio, 0 bucketed):
--      select kind, count(*) as rows,
--             count(*) filter (where bucket_id is not null) as bucketed
--        from public.attachments group by kind order by kind;
