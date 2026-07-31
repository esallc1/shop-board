-- ============================================================
-- Office-auth rollout — Step 0: link employees to Supabase Auth users.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS (docs/wiring/office-auth.md §5, Step 0):
--   The first, INVISIBLE step of adding a real office login (Supabase Auth,
--   email invite) ALONGSIDE today's phone+PIN. This only adds a nullable link
--   from an employee to their auth.users id. Nothing reads it yet.
--
-- ⚠️ ADDITIVE + INVISIBLE — nothing is enforced by this migration:
--   • NO row-level-security change. `employees` keeps its exact current posture
--     (still anon read/update, as today). We do NOT tighten it here.
--   • NO foreign key to auth.users yet. A FK would add a check on employees
--     writes, and employees is still anon-updatable this pass; a plain nullable
--     uuid guarantees zero interaction with any existing writer. (The FK is a
--     later hardening, once employee writes move server-side.)
--   • NO login/board change. Everyone still uses phone+PIN; this column stays
--     NULL for everyone until an auth user is linked by hand (Step 1).
--
-- Multiple NULLs are allowed (everyone starts NULL); the partial unique index
-- enforces at most ONE employee per auth user once links exist.
-- ============================================================

alter table public.employees
  add column if not exists auth_user_id uuid;

create unique index if not exists idx_employees_auth_user_id
  on public.employees (auth_user_id) where auth_user_id is not null;

comment on column public.employees.auth_user_id is
  'Nullable link to a Supabase Auth user for the office-login rollout (office-auth.md). NULL = still phone/PIN. No FK/RLS yet — additive only.';

-- ============================================================
-- LINK ONE PERSON (Step 1, Path A) — run after creating the auth user in the
-- dashboard (Authentication > Users > Add user > Create new user, Auto Confirm).
-- Copy the new User UID and their employee phone (digits only):
--
--   update public.employees set auth_user_id = '<CRISTIAN_AUTH_UID>'
--    where phone = '<CRISTIAN_PHONE_DIGITS>';   -- or: where name = 'Cristian'
-- ============================================================

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='employees' and column_name='auth_user_id';
--     -- 1 row: uuid, YES (nullable)
--   -- no policy change — employees policies are unchanged by this migration:
--   select policyname, cmd from pg_policies where tablename='employees';
-- ============================================================

-- ============================================================
-- ROLLBACK (instant, reversible — removes the column + index, nothing else):
--   drop index if exists idx_employees_auth_user_id;
--   alter table public.employees drop column if exists auth_user_id;
--   -- (also null out any link you set, though dropping the column covers it)
-- ============================================================
