-- ============================================================
-- Custom board background photo (per-employee).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Lets each employee upload a personal background photo that's
-- applied to the main content area of whichever board they log into
-- (Advisor, Bookkeeping, GM, Owner). One row per employee, same
-- pattern as employees.photo_url (Employee Management avatars) —
-- reusing that table rather than a new preferences table since this
-- is a single scalar value, not a structured layout like
-- dashboard_preferences.layout.
-- ============================================================

alter table public.employees
  add column if not exists background_photo_url text;

-- ── STORAGE: public bucket for background photos.
--
-- Public (like employee-photos, unlike invoice-images): these are
-- personal decorative photos an employee chose to upload, not
-- sensitive documents, so a permanent public URL via getPublicUrl()
-- is fine — no signed-URL indirection needed.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('board-backgrounds', 'board-backgrounds', true)
on conflict (id) do nothing;

create policy "Allow anon insert to board-backgrounds"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'board-backgrounds');

create policy "Allow anon read board-backgrounds"
  on storage.objects for select
  to anon
  using (bucket_id = 'board-backgrounds');
