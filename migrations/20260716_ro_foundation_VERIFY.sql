-- ============================================================
-- VERIFICATION CHECKLIST for 20260716_ro_foundation.sql
-- Run this in the Supabase SQL Editor AFTER applying the migration.
-- Every query below is read-only. Expected results are noted inline.
-- (Prior lesson: never assume the migration applied — confirm each
-- table + column + enum + the 6000 sequence start actually exists.)
-- ============================================================


-- ── 1. All 9 tables exist ───────────────────────────────────
-- Expect exactly 9 rows.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'customers','vehicles','repair_orders','ro_line_items',
    'labor_codes','symptom_presets','attachments','interactions','authorizations'
  )
order by table_name;


-- ── 2. All 9 enum types exist, with the right labels ────────
-- Eyeball the labels against the spec (e.g. drive_type = FWD/RWD/AWD/4WD,
-- ro_status = estimate/ro/invoice, ro_line_type = labor/parts/fee/
-- shop_supply/hazmat, delivery_preference = print/email/both).
select t.typname as enum_type,
       array_agg(e.enumlabel order by e.enumsortorder) as labels
from pg_type t
join pg_enum e on e.enumtypid = t.oid
where t.typname in (
  'delivery_preference','drive_type','ro_status','ro_line_type',
  'attachment_entity_type','attachment_kind','interaction_kind',
  'interaction_direction','authorization_method'
)
group by t.typname
order by t.typname;


-- ── 3. Full column inventory for the new tables ─────────────
-- Read through and confirm every column from the spec is present with
-- the right type (enums show as USER-DEFINED / udt_name).
select table_name, column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'customers','vehicles','repair_orders','ro_line_items',
    'labor_codes','symptom_presets','attachments','interactions','authorizations'
  )
order by table_name, ordinal_position;


-- ── 4. repair_orders.ro_number identity STARTS AT 6000 ──────
-- Expect: identity_generation = ALWAYS, identity_start = 6000.
select column_name, is_identity, identity_generation, identity_start
from information_schema.columns
where table_schema = 'public'
  and table_name = 'repair_orders'
  and column_name = 'ro_number';

-- And confirm the underlying sequence's next value is 6000 (before any
-- RO has been created). Expect last_value = 6000, is_called = false.
select pg_get_serial_sequence('public.repair_orders','ro_number') as seq_name;
-- Then, substituting the seq name above:
--   select last_value, is_called from public.repair_orders_ro_number_seq;


-- ── 5. repair_orders.po is a STORED generated mirror ────────
-- Expect: is_generated = ALWAYS, generation_expression referencing ro_number.
select column_name, is_generated, generation_expression
from information_schema.columns
where table_schema = 'public'
  and table_name = 'repair_orders'
  and column_name = 'po';


-- ── 6. Foreign keys are in place ────────────────────────────
-- Expect FKs: vehicles.customer_id, repair_orders.customer_id/vehicle_id/
-- parent_ro_id, ro_line_items.repair_order_id, interactions.customer_id/
-- repair_order_id, authorizations.repair_order_id/interaction_id.
select tc.table_name,
       kcu.column_name,
       ccu.table_name  as references_table,
       ccu.column_name as references_column,
       rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_schema = 'public'
  and tc.table_name in (
    'vehicles','repair_orders','ro_line_items','interactions','authorizations'
  )
order by tc.table_name, kcu.column_name;


-- ── 7. Search indexes exist ─────────────────────────────────
-- Expect at least: idx_customers_phone_primary, idx_customers_name,
-- idx_vehicles_plate, idx_vehicles_vin, idx_repair_orders_ro_number,
-- idx_repair_orders_customer_id, idx_repair_orders_vehicle_id.
select tablename, indexname
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'customers','vehicles','repair_orders','ro_line_items',
    'labor_codes','symptom_presets','attachments','interactions','authorizations'
  )
order by tablename, indexname;


-- ── 8. RLS enabled + anon-full-access policy on every table ─
-- Expect rowsecurity = true for all 9, and one "Allow anon full access
-- to <table>" policy each.
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'customers','vehicles','repair_orders','ro_line_items',
    'labor_codes','symptom_presets','attachments','interactions','authorizations'
  )
order by c.relname;

select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'customers','vehicles','repair_orders','ro_line_items',
    'labor_codes','symptom_presets','attachments','interactions','authorizations'
  )
order by tablename;


-- ── 9. All 9 tables registered with supabase_realtime ───────
-- Expect exactly 9 rows.
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in (
    'customers','vehicles','repair_orders','ro_line_items',
    'labor_codes','symptom_presets','attachments','interactions','authorizations'
  )
order by tablename;


-- ── 10. Private storage bucket + its policies ───────────────
-- Expect one row, public = false.
select id, name, public
from storage.buckets
where id = 'crisdata-attachments';

-- Expect the insert + read policies for the bucket.
select policyname, cmd
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and policyname like '%crisdata-attachments%'
order by policyname;


-- ── 11. (Optional) live smoke test that ro_number mints 6000 ─
-- Only run if you want to prove the sequence end-to-end. This INSERTS
-- and then ROLLS BACK, so no real data is left behind.
-- BEGIN;
--   INSERT INTO public.customers (name) VALUES ('__verify__') RETURNING id;
--   -- use that id below:
--   -- INSERT INTO public.vehicles (customer_id) VALUES ('<id>') RETURNING id;
--   -- INSERT INTO public.repair_orders (customer_id, vehicle_id)
--   --   VALUES ('<cust id>', '<veh id>') RETURNING ro_number, po;  -- expect 6000 / '6000'
-- ROLLBACK;
