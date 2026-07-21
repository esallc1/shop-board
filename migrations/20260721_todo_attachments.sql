-- ============================================================
-- To-Do — FILE ATTACHMENTS (one file per to-do, any type).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file.
--
-- One optional attachment per todo row, pointer ON the row (same shape as the
-- chat message attachments). Stored in the existing private
-- crisdata-attachments bucket under todos/<uuid>/<filename> (namespaced apart
-- from chat/ and avatars/), read via short-lived createSignedUrl at render.
-- No new storage policy needed (bucket-wide anon insert/select already exist).
--
-- MULTI-ASSIGN needs NO schema change: assignment stays one row per assignee
-- (existing assigned_to / assigned_to_name single-assignee model); the client
-- fans out N rows on add, each with the SAME attachment_path.
--
-- No RLS change: todos is already anon-full-access (20260715_todos.sql).
-- Resilient: the board loads todos with select('*'), and plain (no-file)
-- to-dos never reference these columns, so adding/listing to-dos keeps working
-- before this migration runs — only file attachments need it.
--
-- Idempotent: add-column-if-not-exists x3, safe to re-run.
-- ============================================================

alter table public.todos add column if not exists attachment_path text;  -- path inside crisdata-attachments (todos/<uuid>/<filename>)
alter table public.todos add column if not exists attachment_name text;  -- original filename (chip display)
alter table public.todos add column if not exists attachment_mime text;  -- content type


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. The three columns exist, all nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='todos'
--   and column_name in ('attachment_path','attachment_name','attachment_mime')
-- order by column_name;   -- ⇒ 3 rows, is_nullable = YES
