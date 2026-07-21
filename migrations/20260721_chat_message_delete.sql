-- ============================================================
-- Team Chat — MESSAGE DELETE (tombstone, own-messages-only, delete-for-everyone).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file.
--
-- Delete is a soft/tombstone UPDATE on the message row: the client nulls the
-- text + attachment pointer and sets deleted_at (+ who). deleted_at IS NOT NULL
-- => the row renders as "🚫 This message was deleted" for everyone; the row
-- stays in place so ordering + day dividers are unaffected.
--
-- NO realtime-publication change needed: chat_messages is already in
-- supabase_realtime (INSERT receipts/messages work live), and a table in the
-- publication broadcasts UPDATE too — the UPDATE `new` payload carries the full
-- new row (deleted_at set, message/attachment nulled), which is all the client
-- reads. NO RLS change needed: chat_messages already allows anon UPDATE
-- (verified live with a no-op PATCH → HTTP 200 + row returned), same
-- app-level/PIN model as the rest of chat.
--
-- Idempotent: add-column-if-not-exists x2, safe to re-run.
-- ============================================================

alter table public.chat_messages add column if not exists deleted_at timestamptz;  -- set => tombstoned (message deleted for everyone)
alter table public.chat_messages add column if not exists deleted_by text;          -- who deleted it (own-messages-only, so = sender_name)


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. Both columns exist, nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='chat_messages'
--   and column_name in ('deleted_at','deleted_by') order by column_name;  -- ⇒ 2 rows, YES
