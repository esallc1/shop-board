-- ============================================================
-- Advisor desk — call log: deliberate ATTACH / UN-ATTACH + "not a customer".
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Extends `calls` again (slices 2 / 3a / 3b / 3e unchanged); other tables
-- untouched.
--
-- WHY: calls.customer_id has only ever been written as a SIDE EFFECT of Josh
-- acting on a live ring-time card, so it was unreliable — which is exactly why
-- slice 3e made the call log resolve identity by a LIVE last-10 phone match
-- instead of trusting the column. This slice keeps that rule and finally gives
-- customer_id a deliberate meaning: A HUMAN CONFIRMED THIS CALL IS THIS PERSON.
--
--   attached_by_name / attached_at  — who confirmed the attach, and when.
--   learned_phone (default false)   — TRUE only when the attach itself wrote
--       the caller's number into customers.phone_secondary (an empty slot).
--       Un-attach clears phone_secondary ONLY when this flag is true, so a
--       pre-existing number is never deleted by undoing a linking mistake.
--   not_a_customer_at / _by_name    — a reversible mark for spam / wrong
--       numbers, so they can leave the Unattached list without inventing a
--       person (avoids the Declined-lane "permanent noise" failure mode).
--
-- customer_id ALREADY EXISTS (slice 2) — deliberately not re-added here.
--
-- No RLS change: the anon UPDATE policy from slice 3a already covers new
-- columns (same as 20260728_calls_resolved.sql). No new enum.
-- ============================================================

alter table public.calls
  add column if not exists attached_by_name     text,
  add column if not exists attached_at          timestamptz,
  add column if not exists learned_phone        boolean not null default false,
  add column if not exists not_a_customer_at    timestamptz,
  add column if not exists not_a_customer_by_name text;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_name='calls'
--      and column_name in ('attached_by_name','attached_at','learned_phone',
--                          'not_a_customer_at','not_a_customer_by_name')
--    order by column_name;                                   -- ⇒ 5 rows
--
--   -- unattached calls (no confirmed customer, not marked not-a-customer):
--   select id, caller_bare, customer_id, attached_by_name, learned_phone,
--          not_a_customer_at
--     from public.calls
--    where customer_id is null and not_a_customer_at is null
--    order by started_at desc
--    limit 20;
-- ============================================================
