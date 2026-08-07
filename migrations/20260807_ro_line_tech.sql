-- ============================================================
-- CrisData — ro_line_items.line_tech_id (per-line tech credit).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one additive column so a LABOR line's hours can credit to a specific
-- technician when a 2nd tech did one piece (e.g. a radiator). NULL = inherit the
-- RO's assigned technician (repair_orders.technician). This is tech-PAY data —
-- it never touches price/tax math.
--
-- ROLLUP: a tech's weekly Billed Hrs = Σ labor-line hours credited to them
-- (line_tech_id when set, else the RO's assigned tech) + Σ package R&R hours on
-- ROs where they are the assigned tech. All behind the Book Hours feature switch.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS). ro_line_items already
-- carries anon + authenticated RLS policies (office-auth widen,
-- 20260801_office_auth_widen_step1_5.sql), so NO policy / RLS change is needed —
-- the new column inherits the table's grants. The app degrades quietly if this
-- isn't applied yet (a labor line saves without its per-line tech; missing-column
-- write is caught and retried without line_tech_id).
-- ============================================================

alter table public.ro_line_items
  add column if not exists line_tech_id uuid references public.employees(id) on delete set null;
  -- NULL = credit the RO's assigned technician; a value = credit that employee

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='ro_line_items'
--      and column_name='line_tech_id';
--   -- expect: line_tech_id | uuid | YES
--
--   -- FK is in place (references employees):
--   select constraint_name from information_schema.table_constraints
--    where table_schema='public' and table_name='ro_line_items'
--      and constraint_type='FOREIGN KEY';
-- ============================================================
