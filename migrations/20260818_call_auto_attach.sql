-- ============================================================
-- Auto-attach (Phase 2) — the UNDO TAG on `calls`.
-- Run BY HAND. ✅ ALREADY RUN ON SANDBOX (efhmefpaijjncwgbvwki) 2026-08-18.
-- NOT run on prod (hygemiszxwmyrkmhbjub).
--
-- Additive only: 3 nullable columns + 1 partial index. No default, so no table
-- rewrite. No data change. No policy change. No drop.
--
-- WHY THESE THREE
-- The crew's attach stamps attached_by_name + attached_at
-- (shared/call-attach.js attachCallPatch). The robot NEVER writes those two
-- columns — that alone keeps the namespaces separate. These columns make the
-- robot's work ADDRESSABLE, so a single statement can reverse exactly one run
-- and nothing else. See docs/wiring/call-auto-attach.md §3.
--
-- No new RLS is needed: public.calls already carries SELECT + UPDATE for BOTH
-- anon and authenticated (20260728_calls.sql, 20260728_calls_notes.sql,
-- 20260801_office_auth_widen_step1_5.sql), and those policies are table-level
-- `using (true)` — not column-scoped — so new columns are covered automatically.
-- ============================================================

begin;

alter table public.calls
  add column if not exists auto_attached_at   timestamptz,
  add column if not exists auto_ro_filed_at   timestamptz,
  add column if not exists auto_attach_run_id uuid;

comment on column public.calls.auto_attached_at is
  'Set by auto-attach when IT set customer_id. NULL on every human attach (humans stamp attached_by_name/attached_at instead).';
comment on column public.calls.auto_ro_filed_at is
  'Set by auto-attach when IT set ro_id. MUST be cleared whenever a human re-files the call, so undo can never revoke a human decision.';
comment on column public.calls.auto_attach_run_id is
  'Which auto-attach run touched this row. The undo key: one run id = one reversible batch.';

create index if not exists calls_auto_attach_run_id_idx
  on public.calls (auto_attach_run_id)
  where auto_attach_run_id is not null;

commit;

-- ── VERIFY ──────────────────────────────────────────────────────────────
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_schema='public' and table_name='calls' and column_name like 'auto_%';
--
-- ── THE RUN-ID NAMESPACE (docs/wiring/call-auto-attach.md §3) ───────────
--   11111111-2222-4333-8444-555555555555  backfill pass 1 (attach + file)
--   22222222-3333-4444-8555-666666666666  backfill pass 2 (file only)
--   00000000-0000-4000-8000-000000000000  LIVE — every going-forward attach
--                                          (AUTO_ATTACH_LIVE_RUN_ID)
