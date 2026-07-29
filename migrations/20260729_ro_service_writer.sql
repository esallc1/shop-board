-- ============================================================
-- CrisData RO — stored SERVICE WRITER (the actor the RO was written by).
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- WHY: printRo() prints a "Service Advisor" line, but today it derives that
-- name from CHAT_IDENTITY at PRINT TIME — i.e. whoever is logged in on the
-- browser when Print is clicked. If Kevin prints an RO that Josh wrote, the
-- customer's paperwork says Kevin. That is wrong data leaving the shop. This
-- column stores WHO wrote the RO so the printed line can tell the truth.
--
-- repair_orders already has six stage timestamps but no actor record of any
-- kind, and that history cannot be reconstructed. This is the first actor
-- column. It is deliberately ONE nullable FK — NOT a per-stage actor set and
-- NOT an events table (both out of scope).
--
-- NULLABLE, no default, no backfill: the ~30 existing ROs predate this and
-- stay NULL. NULL honestly means "written before we tracked the writer" and
-- prints as '—'. We do not guess an author for old paperwork.
--
-- Stores the employee ID (uuid FK → employees.id), NOT a free-text name. This
-- is deliberately unlike the existing `technician` free-text column, which is a
-- known shortcut we are NOT repeating here. ON DELETE SET NULL: removing an
-- employee must never delete or block their ROs — the writer just goes blank.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS): safe to paste / re-run.
-- The app ships with a pre-migration fallback (selects retry without this
-- column; creation retries without it; print shows '—'), so the RO board keeps
-- working in the window before this is applied. Same resilience lesson as the
-- declined_estimate / returned_by columns.
-- ============================================================

alter table public.repair_orders
  add column if not exists service_writer_id uuid
    references public.employees(id) on delete set null;

create index if not exists idx_repair_orders_service_writer_id
  on public.repair_orders (service_writer_id);

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='repair_orders'
--      and column_name='service_writer_id';   -- ⇒ uuid, YES (nullable)
--
--   -- existing ROs are all NULL (no backfill):
--   select count(*) as total,
--          count(service_writer_id) as with_writer
--     from public.repair_orders;               -- ⇒ with_writer = 0 right after apply
-- ============================================================
