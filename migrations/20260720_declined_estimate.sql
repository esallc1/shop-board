-- ============================================================
-- Declined-estimate flag + callback list (CrisData RO board).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- Cris's decision: "Declined" is a FLAG on an estimate, NOT a new stage.
-- The status enum (estimate | ro | invoice | closed) is unchanged. A
-- declined estimate = status='estimate' with declined_at set; it's pulled
-- off the active kanban into a callback list. Money/totals are untouched —
-- declining creates no invoice and changes no line items.
--
-- Additive + nullable only → safe to run mid-workday. First real case is
-- RO #5473.
--
-- The advisor board loads these columns resiliently: if this migration
-- hasn't run yet, the RO board falls back to its old query and the declined
-- feature stays dormant (no breakage). The feature lights up once this runs.
-- ============================================================

alter table public.repair_orders
  add column if not exists declined_at     timestamptz null,
  add column if not exists declined_reason text        null;

-- Callback list = declined estimates, newest declined_at first.
create index if not exists idx_repair_orders_declined_at
  on public.repair_orders (declined_at desc)
  where declined_at is not null;
