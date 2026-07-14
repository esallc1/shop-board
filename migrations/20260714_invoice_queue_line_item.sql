-- ============================================================
-- Bookkeeping Board — Description + Part Number fields for the
-- invoice auto-detection feature (Parts/Vendor invoices only).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- description: line-item description of what was purchased, as
-- printed on the invoice (e.g. "SPC DW EXTR").
-- part_number: the item/part number, if printed — often a separate
-- value from the PO#.
-- ============================================================

alter table public.invoice_queue
  add column if not exists description text,
  add column if not exists part_number text;
