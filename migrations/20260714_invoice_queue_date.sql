-- ============================================================
-- Bookkeeping Board (Phase 4, revised) — classify/organize/present
-- for manual QuickBooks entry (no QuickBooks API calls this phase —
-- AP-side write access, vendor lookup, and Chart of Accounts aren't
-- available in the connected environment).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Adds the user-entered transaction date, captured at classify time
-- (distinct from uploaded_at, when Josh took the photo, and
-- processed_at, when Daiana confirmed it). Used for the vendor/date
-- storage folder and shown in the History tab.
--
-- Also adds the missing UPDATE policy on the invoice-images bucket.
-- Confirmed live (uploaded a throwaway test object, then called the
-- move endpoint directly): Supabase Storage's move/rename is
-- implemented as an update of the object's path, and the bucket only
-- had insert/select/delete policies (delete added in Phase 3) — no
-- update — so every move Phase 4's classify flow attempts would fail
-- with a false "Object not found" (RLS silently filtering, not
-- actually missing). Without this, storage reorganization (point 1)
-- does not work.
-- ============================================================

alter table public.invoice_queue
  add column if not exists invoice_date date;

create policy "Allow anon update invoice-images"
  on storage.objects for update
  to anon
  using (bucket_id = 'invoice-images')
  with check (bucket_id = 'invoice-images');
