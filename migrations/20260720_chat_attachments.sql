-- ============================================================
-- Team Chat — Slice 4a: message attachments (photo, then file/voice).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file (not the whole 20260720 batch — same lesson as 3a).
--
-- DATA MODEL DECISION (Cris): one attachment per message, pointer lives ON
-- the chat_messages row (NOT the shared `attachments` table). Storage reuses
-- the existing private `crisdata-attachments` bucket (bucket-wide anon
-- insert/select policies from 20260716_ro_foundation.sql — no new storage
-- policy needed), read via short-lived createSignedUrl at render time.
--
-- All three kinds ('photo','file','voice') are allowed NOW so the 4b (file)
-- and 4c (voice) slices need no further migration — they reuse these columns.
-- Every column is nullable: a plain text message leaves them all null; an
-- attachment can ride with an optional caption (message) OR stand alone.
--
-- Idempotent: add-column-if-not-exists + drop-then-add the CHECK constraint.
-- ============================================================

alter table public.chat_messages add column if not exists attachment_path text;  -- path inside crisdata-attachments
alter table public.chat_messages add column if not exists attachment_kind text;  -- 'photo' | 'file' | 'voice'
alter table public.chat_messages add column if not exists attachment_name text;  -- original filename (file/download display)
alter table public.chat_messages add column if not exists attachment_mime text;  -- content type

-- Constrain the kind (null = a plain text message). Drop-then-add = idempotent.
alter table public.chat_messages drop constraint if exists chat_messages_attachment_kind_check;
alter table public.chat_messages add constraint chat_messages_attachment_kind_check
  check (attachment_kind is null or attachment_kind in ('photo', 'file', 'voice'));

-- An attachment-only message has no text — make sure `message` is nullable.
-- (Safe/no-op if it already is.)
alter table public.chat_messages alter column message drop not null;


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. The four columns exist, all nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='chat_messages'
--   and column_name in ('attachment_path','attachment_kind','attachment_name','attachment_mime')
-- order by column_name;   -- ⇒ 4 rows, is_nullable = YES

-- V2. The kind CHECK is present and allows only photo/file/voice (or null).
-- select conname, pg_get_constraintdef(oid) as def
-- from pg_constraint
-- where conrelid='public.chat_messages'::regclass and conname='chat_messages_attachment_kind_check';

-- V3. message is nullable (attachment-only rows are legal).
-- select is_nullable from information_schema.columns
-- where table_schema='public' and table_name='chat_messages' and column_name='message';  -- ⇒ YES
