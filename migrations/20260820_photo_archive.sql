-- ============================================================
-- Photo archive + provenance — SLICE 2, SCHEMA ONLY.
-- Run BY HAND. ✅ SANDBOX FIRST (efhmefpaijjncwgbvwki). ❌ NOT on prod.
--
-- ADDITIVE ONLY: three nullable columns on `attachments`. No DROP, no UPDATE,
-- no DELETE, no index, no policy change, NO STORAGE CHANGE. All three columns
-- are nullable with no default, so this is a catalog-only change — Postgres
-- does NOT rewrite the table, and every existing row simply gets NULL.
--
-- ── 1. ARCHIVE, NOT DESTROY ───────────────────────────────────────────
-- A tech shoots a blurry frame or the wrong car; that cannot be permanent on a
-- customer's record. But "nothing is ever deleted" is this feature's rule, so a
-- removed photo is TOMBSTONED, not destroyed: the row stays, the storage object
-- stays, and every reader filters it out.
--
-- The shape is copied EXACTLY from chat's tombstone
-- (migrations/20260721_chat_message_delete.sql):
--     chat_messages.deleted_at  timestamptz   -- set => tombstoned
--     chat_messages.deleted_by  text          -- who did it
-- Same names, same types, same meaning, so the two read the same way.
--
-- ⚠️ THE STORAGE OBJECT IS DELIBERATELY LEFT IN THE BUCKET. Hard purge is
--    explicitly out of scope for this slice. That means an archived photo is
--    hidden from every board but its bytes still exist and are still signable
--    by anyone who can read the row. Fine for a blurry frame; NOT sufficient on
--    its own for a photo of the WRONG CUSTOMER'S vehicle. Purge needs a delete
--    policy on `crisdata-attachments` (which today has none, for either role)
--    and is its own decision — see docs/wiring/ro-photos.md.
--
-- ── 2. WHO TOOK IT ────────────────────────────────────────────────────
-- `uploaded_by` mirrors `marketing_content.captured_by` — it stores the NAME as
-- text, not an employee id. That is the working in-house precedent
-- (20260716_marketing_content.sql, written by shared/catch-moment.js) and it
-- survives an employee row being edited or deactivated, which is what you want
-- on a historical record.
--
-- ⚠️ POPULATES GOING FORWARD ONLY. Every attachment that already exists gets
--    NULL and stays NULL — the uploader was never captured and cannot be
--    reconstructed. Those rows are OWNERLESS by definition; see the permission
--    note below for what that means in the UI.
-- ============================================================

begin;

alter table public.attachments
  add column if not exists uploaded_by text,
  add column if not exists deleted_at  timestamptz,
  add column if not exists deleted_by  text;

comment on column public.attachments.uploaded_by is
  'Display NAME of whoever captured this (not an employee id) — mirrors marketing_content.captured_by. NULL on every row created before 2026-08-20: ownerless, not "unknown user".';
comment on column public.attachments.deleted_at is
  'Tombstone. Set => archived: hidden from every reader, but the row AND the storage object are kept. Same meaning as chat_messages.deleted_at.';
comment on column public.attachments.deleted_by is
  'Display NAME of whoever archived it. Same meaning as chat_messages.deleted_by.';

commit;

-- PostgREST caches the schema; without this the first reads selecting the new
-- columns 400 until the cache refreshes on its own.
notify pgrst, 'reload schema';


-- ── PERMISSION RULE (enforced in the UI, not the DB) ──────────────────
-- Whoever took the photo may archive it, plus the office on the customer
-- record. A tech may NOT archive another tech's photo. This is deliberately
-- NOT an RLS rule: `attachments` carries table-level `for all` for both anon
-- and authenticated, and My Numbers authenticates with a PIN against
-- `employees`, not a Supabase Auth session — so the DB has no identity to
-- enforce against. Same posture as every other permission in this app
-- (app-level, not DB-level). Tightening that is the office-auth project's job,
-- not this slice's.
--
-- OWNERLESS ROWS: uploaded_by IS NULL means nobody can prove they took it, so
-- NO TECH can archive it. The office still can, from the customer record. That
-- is the safe reading — it never lets one tech remove another's work on a
-- technicality, and it leaves a cleanup path for the handful of pre-slice-2
-- photos.


-- ── VERIFY ────────────────────────────────────────────────────────────
-- 1. The three columns exist and are all nullable (expect 3 rows, all YES):
--      select column_name, data_type, is_nullable
--        from information_schema.columns
--       where table_schema='public' and table_name='attachments'
--         and column_name in ('uploaded_by','deleted_at','deleted_by')
--       order by column_name;
--
-- 2. Nothing was touched — every existing row is live and ownerless
--    (expect deleted = 0, and owned = 0 until new photos are shot):
--      select count(*) as rows,
--             count(*) filter (where deleted_at  is not null) as deleted,
--             count(*) filter (where uploaded_by is not null) as owned
--        from public.attachments;
--
-- 3. Shape matches chat's tombstone (expect the same two column names/types):
--      select table_name, column_name, data_type
--        from information_schema.columns
--       where table_schema='public'
--         and table_name in ('attachments','chat_messages')
--         and column_name in ('deleted_at','deleted_by')
--       order by table_name, column_name;
