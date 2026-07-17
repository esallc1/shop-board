-- ============================================================
-- CrisData Phase 4, Slice 2 — Tech Diagnosis capture: the schema behind
-- the digital replacement for ALLDATA's printed tech sheet. Run in the
-- Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- A tech opens an RO assigned to him (repair_orders.technician, landed in
-- Phase 3), sees complaint + vehicle read-only, and records his diagnosis
-- back ONTO the RO so the advisor builds the estimate without re-keying:
--   * DTCs  -> structured, one row per code (new ro_diagnostic_codes)
--   * Recommendation -> free text on the RO (typed, or a voice transcript)
--   * Submitting PUSHES the RO into the advisor's Approval Queue.
--
-- ADDITIVE ONLY. Parallel/beta on the CrisData RO tables; does NOT touch
-- the live shop floor (shopboard_*), the Approval Queue's ALLDATA-era
-- path, parts_orders, or completed_jobs. Idempotent — safe to re-run.
-- The app has pre-migration fallbacks so nothing breaks in the window
-- before this is applied.
--
-- VOICE (decided — record + attach audio now, transcript deferred): the
-- recommendation TEXT lives here (diagnosis_recommendation, typed for now).
-- The tech can ALSO record audio; the clip attaches via the existing
-- attachments table (entity_type='repair_order', kind='diagnosis_audio')
-- and lives in the crisdata-attachments bucket as the source of truth.
-- Automatic transcription is DEFERRED to a separate Whisper-backend thread
-- (Supabase Edge Function + OpenAI key) — until then the advisor listens to
-- the clip; the codes are structured so nothing needs re-keying.
-- ============================================================

-- ── 0. attachment_kind — add the diagnosis-audio value ───────
-- ⚠️ ALTER TYPE ... ADD VALUE cannot be USED in the same transaction that
-- adds it. Nothing in THIS migration inserts an attachment, so it's safe
-- alongside the DDL below. If the SQL Editor ever errors with "ALTER TYPE
-- ... ADD VALUE cannot run inside a transaction block", run just this one
-- line by itself first, then re-run the rest.
alter type public.attachment_kind add value if not exists 'diagnosis_audio';

-- ── 1. ro_diagnostic_codes — one row per DTC per RO ──────────
-- Bare codes only (no per-code note). ANY format accepted (P/U/B/C +
-- manufacturer-specific/oddball) — no leading-letter validation. Stored
-- UPPERCASE (app-normalized: p0730 -> P0730) so the future cross-vehicle
-- code-search screen banks clean, matchable data.
create table if not exists public.ro_diagnostic_codes (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references public.repair_orders(id) on delete cascade,
  code text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ro_diagnostic_codes_repair_order_id
  on public.ro_diagnostic_codes (repair_order_id);
-- indexed for the later "find this code across all our jobs" search
create index if not exists idx_ro_diagnostic_codes_code
  on public.ro_diagnostic_codes (code);

-- ── 2. repair_orders — recommendation text + handoff timestamps ──
-- diagnosis_recommendation : the tech's recommendation (typed or a voice
--                            transcript); readable/searchable on the RO.
-- diagnosis_submitted_at   : set when the tech pushes the diagnosis ->
--                            this is the "diagnosis ready" signal the
--                            advisor's Approval Queue keys on.
-- diagnosis_reviewed_at    : set when the advisor opens it from the queue
--                            -> drops it off the queue. NULL = still ready.
alter table public.repair_orders add column if not exists diagnosis_recommendation text;
alter table public.repair_orders add column if not exists diagnosis_submitted_at   timestamptz;
alter table public.repair_orders add column if not exists diagnosis_reviewed_at    timestamptz;

-- ── 3. RLS — anon full access (app-level auth, mirrors every other
--    CrisData table; no Supabase Auth anywhere in this app) ──
alter table public.ro_diagnostic_codes enable row level security;
drop policy if exists "Allow anon full access to ro_diagnostic_codes" on public.ro_diagnostic_codes;
create policy "Allow anon full access to ro_diagnostic_codes"
  on public.ro_diagnostic_codes for all to anon using (true) with check (true);

-- ── 4. REALTIME — SQL-Editor tables aren't auto-added to the
--    publication; guard so re-runs don't error ──
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ro_diagnostic_codes'
  ) then
    alter publication supabase_realtime add table public.ro_diagnostic_codes;
  end if;
end $$;

-- ============================================================
-- VERIFY (run separately, after the migration commits)
-- ============================================================
-- (a) new table + columns exist:
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema='public' and table_name='ro_diagnostic_codes'
--    order by ordinal_position;
--   -- expect: id | repair_order_id | code | created_at
--
-- (b) repair_orders gained the three columns:
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema='public' and table_name='repair_orders'
--      and column_name in ('diagnosis_recommendation','diagnosis_submitted_at','diagnosis_reviewed_at')
--    order by column_name;
--   -- expect 3 rows: diagnosis_recommendation(text),
--   --                diagnosis_reviewed_at(timestamptz),
--   --                diagnosis_submitted_at(timestamptz)
--
-- (c) RLS policy + realtime registration:
--   select policyname from pg_policies
--    where schemaname='public' and tablename='ro_diagnostic_codes';
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='ro_diagnostic_codes';
--
-- (d) attachment_kind gained 'diagnosis_audio':
--   select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
--    where t.typname='attachment_kind' order by e.enumsortorder;
--   -- expect: id_photo | walkaround | tax_cert | diagnosis_audio
