-- ============================================================
-- Phase A of customer dedupe (docs/wiring/customer-dedupe.md §4/§7).
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   A multi-phone model — a customer can have many numbers (e.g. a wife's cell) —
--   so a call from a new number resolves to the existing customer instead of
--   minting a duplicate. This is Phase A only: the table + a one-time backfill.
--
-- ⚠️ ADDITIVE + INERT — nothing changes for anyone:
--   • NOTHING reads customer_phones yet (that is Phase B). This is a snapshot.
--   • customers.phone_primary / phone_secondary stay AUTHORITATIVE and untouched;
--     the existing code keeps writing them, unchanged.
--   • No board/app change, no enforcement. Because it is inert, this one is safe
--     to run during hours (the calm-window rule is for the Phase B/C deploys).
--
-- SYNC DURING TRANSITION (no trigger — by decision): customer_phones is a snapshot
--   here; any drift (a customer created after this backfill) is harmless while
--   nothing reads it. At the Phase B cutover we re-run the idempotent
--   "insert-missing" backfill to catch up, and Phase B dual-writes so the legacy
--   columns and this table stay in lockstep from then on.
-- ============================================================

create table if not exists public.customer_phones (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  phone_norm    text not null,                 -- last-10 digits, the match key
  phone_display text,                           -- as entered/formatted, for display
  label         text,                           -- 'mobile' | 'home' | 'work' | 'wife' | … (free text)
  is_primary    boolean not null default false,
  source        text,                           -- 'backfill_primary' | 'backfill_secondary' | later 'callin' | 'attach'
  created_at    timestamptz not null default now()
);

create index if not exists idx_customer_phones_norm     on public.customer_phones (phone_norm);
create index if not exists idx_customer_phones_customer  on public.customer_phones (customer_id);
-- a number is NOT globally unique (families share a line); but at most one primary per customer:
create unique index if not exists uq_customer_phones_primary on public.customer_phones (customer_id) where is_primary;

-- RLS: mirror `customers` (anon full access) so Phase B can read/write with the board key.
-- (When the parked Step 1½ read/write widen runs, customer_phones is included in its
--  arrays — see office-auth.md §7 — so a logged-in office session isn't blinded to it.)
alter table public.customer_phones enable row level security;
drop policy if exists "Allow anon full access to customer_phones" on public.customer_phones;
create policy "Allow anon full access to customer_phones"
  on public.customer_phones for all to anon using (true) with check (true);

-- ── Backfill: primary numbers ──
insert into public.customer_phones (customer_id, phone_norm, phone_display, is_primary, source)
select id, right(regexp_replace(phone_primary,'\D','','g'),10), phone_primary, true, 'backfill_primary'
  from public.customers
 where phone_primary is not null
   and length(regexp_replace(phone_primary,'\D','','g')) >= 10;

-- ── Backfill: secondary numbers (skip when identical to the primary) ──
insert into public.customer_phones (customer_id, phone_norm, phone_display, is_primary, source)
select c.id, right(regexp_replace(c.phone_secondary,'\D','','g'),10), c.phone_secondary, false, 'backfill_secondary'
  from public.customers c
 where c.phone_secondary is not null
   and length(regexp_replace(c.phone_secondary,'\D','','g')) >= 10
   and not exists (
     select 1 from public.customer_phones p
      where p.customer_id = c.id
        and p.phone_norm = right(regexp_replace(c.phone_secondary,'\D','','g'),10));

-- ============================================================
-- VERIFY (run after applying):
--   -- row counts (primaries + distinct secondaries):
--   select count(*) filter (where is_primary) as primaries, count(*) as total from public.customer_phones;
--   -- the one-primary invariant holds (expect 0 rows):
--   select customer_id from public.customer_phones where is_primary group by customer_id having count(*) > 1;
--   -- spot-check a customer resolves to all their numbers:
--   select phone_norm, is_primary, source from public.customer_phones
--     where customer_id = '<some customer id>' order by is_primary desc;
--   -- RLS present (anon full access), one policy:
--   select policyname, cmd, roles from pg_policies where tablename = 'customer_phones';
-- ============================================================

-- ============================================================
-- ROLLBACK (clean — nothing references customer_phones yet):
--   drop table if exists public.customer_phones cascade;
--   -- customers.phone_primary / phone_secondary are untouched; nothing is lost.
-- ============================================================
