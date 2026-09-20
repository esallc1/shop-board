-- ============================================================
-- Fix: chat_messages.sender_role CHECK constraint blocks the
-- Bookkeeping role from sending Team Chat messages.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Reported live: Daiana (role='bookkeeping') tried to send a Team
-- Chat message and got a real Postgres error —
--   "new row for relation \"chat_messages\" violates check
--    constraint \"chat_messages_sender_role_check\""
-- This is a SEPARATE constraint from chat_messages_channel_check
-- (already widened in migrations/20260713_invoice_queue.sql) — that
-- one gates the `channel` column, this one gates `sender_role`, and
-- both were apparently hardcoded to the original four roles
-- (tech/advisor/manager/owner) when this table was created directly
-- in the SQL Editor, before this repo's migrations/ folder existed.
-- ============================================================

-- ── STEP 1 (do this first): confirm exact current constraint defs ──
-- PostgREST + the anon key cannot read pg_constraint/information_schema
-- (confirmed repeatedly — no read-only path exists from the app side),
-- so this can only be checked by running SQL directly. This query lists
-- EVERY check constraint in the public schema in one shot, specifically
-- so we catch any other hardcoded-to-4-roles gap in the same pass
-- instead of hitting them one at a time as they break in production:
--
--   select
--     conrelid::regclass as table_name,
--     conname as constraint_name,
--     pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where contype = 'c'
--     and connamespace = 'public'::regnamespace
--   order by table_name, constraint_name;
--
-- Compare chat_messages_sender_role_check's actual definition against
-- the assumption below (tech/advisor/manager/owner) before running
-- STEP 2 — if it differs, adjust the value list to match reality
-- rather than what's assumed here.
-- ============================================================

-- ── STEP 2: widen the constraint ──
alter table public.chat_messages drop constraint if exists chat_messages_sender_role_check;

alter table public.chat_messages add constraint chat_messages_sender_role_check
  check (sender_role in (
    'tech',
    'advisor',
    'manager',
    'owner',
    'bookkeeping'
  ));
