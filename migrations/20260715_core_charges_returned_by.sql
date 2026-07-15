-- ============================================================
-- Bookkeeping / GM Boards — Core Bank: record WHO returned a core.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Adds returned_by (text): the display name of the logged-in employee
-- who marked a core returned (the same value shown in each board's
-- "Hi, X" greeting). Set alongside returned=true / returned_at=now();
-- cleared back to null on Undo. Nullable, no default — pre-existing
-- returned rows simply show "Returned by someone" until re-marked.
--
-- Both boards read it to render "Returned by {name} • {date}" in their
-- Returned lists (Bookkeeping Overview Core Bank + GM Overview Core
-- Bank card).
-- ============================================================

alter table public.core_charges
  add column if not exists returned_by text;
