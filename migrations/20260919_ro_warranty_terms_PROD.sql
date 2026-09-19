-- ============================================================================
-- "Warranty given" on the RO — PROD run (hygemiszxwmyrkmhbjub / www + board).
-- The sandbox has its own file: 20260919_ro_warranty_terms_SANDBOX.sql
-- (identical except the inverted guard). Wiring: docs/wiring/ro-invoice.md §5.
--
-- Adds repair_orders.warranty_terms: the warranty the shop is GIVING the
-- customer, as FULL TEXT — exactly what prints on the estimate / RO / invoice.
-- NULL = none stated (nothing prints). Presets live in shared/warranty-presets.js
-- but only fill the box; the TEXT is stored, never a preset name, so rewording a
-- preset later never changes a document a customer already has.
--
-- NOT the Warranty / Comeback switch (that is shopboard_*.warranty on the floor
-- row and never prints). No backfill: old ROs keep their warranty wording inside
-- advisory_notes, so their reprints don't change beyond the line-break fix.
--
-- Run BY HAND in the Supabase SQL editor — SANDBOX FIRST, then PROD.
-- Order vs the app: either order is safe. Until this column exists the RO
-- detail shows the box greyed out ("needs the database update"), the print
-- shows no Warranty block, and the Bookkeeping RO pane retries without it.
--
-- SELF-GUARDING (staging-db.md §8.2/§8.3): refuses to run unless app_env says PROD — it cannot touch the sandbox.
-- Safe to re-run (add column if not exists; the CHECK is added only if missing).
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

  -- Nullable, no default → metadata-only, no table rewrite. Existing table RLS
  -- covers the new column (no policy change).
  alter table public.repair_orders
    add column if not exists warranty_terms text;
  comment on column public.repair_orders.warranty_terms is
    'Warranty GIVEN on this RO, full text as printed on the estimate/RO/invoice (shared/ro-invoice.js). NULL = none stated. Presets: shared/warranty-presets.js (text copied in, never referenced). Not the Warranty/Comeback floor switch.';

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.repair_orders'::regclass
       and conname  = 'repair_orders_warranty_terms_len'
  ) then
    alter table public.repair_orders
      add constraint repair_orders_warranty_terms_len
      check (warranty_terms is null or char_length(warranty_terms) <= 2000);
  end if;

  raise notice 'warranty_terms added on %', v;
end $$;

notify pgrst, 'reload schema';

-- VERIFICATION (expect: text / YES / no default; the CHECK text; set_count = 0; the PROD stamp)
--   select env from public.app_env;
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'repair_orders' and column_name = 'warranty_terms';
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.repair_orders'::regclass and conname = 'repair_orders_warranty_terms_len';
--   select count(*) filter (where warranty_terms is not null) as set_count, count(*) as all_ros
--     from public.repair_orders;


-- ════════════════════════════════════════════════════════════════════════════
-- UNDO (not run). Drops the CHECK and the column — any warranty text entered on
-- ROs since is LOST from the RO (documents already printed/PDF'd keep it).
-- Deploy the app version without the box first, or it shows its
-- "needs the database update" note again (harmless).
--
--   alter table public.repair_orders drop constraint if exists repair_orders_warranty_terms_len;
--   alter table public.repair_orders drop column if exists warranty_terms;
--   notify pgrst, 'reload schema';
-- ════════════════════════════════════════════════════════════════════════════
