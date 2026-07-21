-- ============================================================
-- Team Chat — Avatars/Settings sub-slice 2: group photo.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file (NOT the whole 20260721 batch — re-applying older
-- migrations throws "already exists"; same lesson as 3a / 4a).
--
-- Adds a single nullable pointer to the group's avatar object, stored in the
-- existing private `crisdata-attachments` bucket under
--   avatars/group/<conversationId>/<uuid>
-- (namespaced apart from message attachments under chat/<conversationId>/…).
-- Read via short-lived createSignedUrl at render time — same pattern as the
-- 4a message photos, so no new storage policy is needed (the bucket-wide anon
-- insert/select policies from 20260716_ro_foundation.sql already cover it).
--
-- ANY member may set/change/remove a group's photo (low-stakes + reversible);
-- there is no creator gate here — creator-only gating is reserved for the later
-- destructive sub-slices (remove members, delete group). null photo_path = the
-- generic 👥 group glyph.
--
-- Idempotent + self-contained: add-column-if-not-exists, safe to re-run.
-- ============================================================

alter table public.chat_conversations
  add column if not exists photo_path text;  -- path inside crisdata-attachments (avatars/group/<conversationId>/<uuid>); null = glyph


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. The column exists and is nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='chat_conversations'
--   and column_name='photo_path';   -- ⇒ 1 row, is_nullable = YES, data_type = text
