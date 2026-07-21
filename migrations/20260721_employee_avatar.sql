-- ============================================================
-- Team Chat — Avatars/Settings sub-slice 3: person profile photos (self-service).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file (NOT the whole 20260721 batch — re-applying older
-- migrations throws "already exists"; same lesson as 3a / 4a / group-photo).
--
-- Adds a single nullable pointer to the person's avatar object, stored in the
-- existing private `crisdata-attachments` bucket under
--   avatars/person/<name-slug>/<uuid>
-- (namespaced apart from group avatars avatars/group/… and message attachments
-- chat/…). Read via short-lived createSignedUrl at render time — same pattern
-- as the 4a message photos + the group photo, so no new storage policy needed.
--
-- SELF-SERVICE: a person only ever sets/changes/removes their OWN photo. The
-- client updates the current user's own employees row (matched by live
-- getIdentity name + role). The employees table is anon-updatable under the
-- existing app-level (PIN) RLS model — verified live with a no-op UPDATE that
-- returned the row — so this write works without loosening any policy.
--
-- NOTE: employees already has an unused `photo_url` (and `background_photo_url`)
-- column; this `avatar_path` is deliberately separate — it is a STORAGE PATH
-- read via signed URL from the private bucket, not a public URL. Leaving the
-- old columns untouched.
--
-- Idempotent + self-contained: add-column-if-not-exists, safe to re-run.
-- ============================================================

alter table public.employees
  add column if not exists avatar_path text;  -- path inside crisdata-attachments (avatars/person/<name-slug>/<uuid>); null = initial circle


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. The column exists and is nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='employees'
--   and column_name='avatar_path';   -- ⇒ 1 row, is_nullable = YES, data_type = text
