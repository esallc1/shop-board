-- ============================================================
-- CrisData — repair_orders.closed_at (STABLE completion stamp for pay).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHY: the weekly per-tech Billed-Hrs rollup must bucket each RO's hours by a
-- timestamp that is set ONCE and never moves — billed hours are a pay-driving
-- number. Until now the rollup used repair_orders.updated_at, which drifts
-- (editing a closed RO later shifts its hours into a later week).
--
-- WHAT: an additive repair_orders.closed_at timestamptz, stamped the FIRST time
-- an RO enters status 'invoice' or 'closed' and NEVER overwritten — enforced by
-- a BEFORE trigger, so it can't be bypassed by any writer (Stage select, kanban
-- drag, archive, anything). (completed_jobs.picked_up_at was considered and does
-- NOT fit: it only exists for picked-up jobs, so invoice-status ROs — work done,
-- billed, not yet collected — would be dropped, and it links by `po` with
-- possible duplicate rows, not cleanly per-RO.)
--
-- SEMANTICS: closed_at = "when the work was first billed/closed", regardless of
-- customer payment. A job invoiced then edited stays in its first week. A job
-- reverted to estimate keeps its stamp but is excluded by the rollup's status
-- filter until it is invoice/closed again (which won't re-stamp).
--
-- ADDITIVE + idempotent. No RLS change (repair_orders already has anon +
-- authenticated policies; the new column inherits them). The app degrades
-- quietly pre-apply (the rollup falls back to updated_at when closed_at is
-- missing).
-- ============================================================

-- ── 1. the column ────────────────────────────────────────────
alter table public.repair_orders
  add column if not exists closed_at timestamptz;   -- set once when first invoice/closed; never moves

-- ── 2. one-time backfill for ROs already invoice/closed ──────
-- These were billed/closed before the stamp existed; updated_at is the best
-- available seed. Runs BEFORE the trigger is created so nothing interferes.
-- Going forward the trigger stamps closed_at once and it never moves.
update public.repair_orders
   set closed_at = updated_at
 where status in ('invoice', 'closed') and closed_at is null;

-- ── 3. set-once trigger — stamp the FIRST time status hits invoice/closed ─
create or replace function public.crisdata_stamp_ro_closed_at()
returns trigger language plpgsql as $$
begin
  -- only stamp when it isn't already set (never overwrite) and the row is
  -- (becoming) invoice/closed. Works on INSERT and UPDATE.
  if new.closed_at is null and new.status in ('invoice', 'closed') then
    new.closed_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_repair_orders_closed_at on public.repair_orders;
create trigger trg_repair_orders_closed_at
  before insert or update on public.repair_orders
  for each row execute function public.crisdata_stamp_ro_closed_at();

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) the column exists:
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='repair_orders' and column_name='closed_at';
--   -- expect: closed_at | timestamp with time zone
--
-- (b) backfill covered every invoice/closed RO:
--   select count(*) from public.repair_orders
--    where status in ('invoice','closed') and closed_at is null;   -- expect 0
--
-- (c) the trigger is installed:
--   select tgname from pg_trigger where tgname='trg_repair_orders_closed_at';
--
-- (d) set-once holds — moving an already-stamped RO's status does NOT change
--     closed_at (spot-check one po before/after a status edit).
-- ============================================================
