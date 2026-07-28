-- ============================================================
-- SCALAR ENRICHMENT of the 27 clean-matched EXISTING customers.
-- Run this AFTER 20260727_alldata_import.sql (which stamps alldata_code
-- on these rows). Fill-missing-ONLY (coalesce) — never overwrites a
-- populated field. Review each row by eye before running; these are your
-- real, in-use customers.
-- ============================================================
begin;
-- ALEX  (alldata ALE006)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-17'::date) where alldata_code = 'ALE006';

-- ALEX PELLOT  (alldata PEL002)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-22'::date) where alldata_code = 'PEL002';

-- ALEXANDER SANCHEZ  (alldata SAN030)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-10'::date) where alldata_code = 'SAN030';

-- ANTHONY  (alldata ANT004)
update public.customers set email = coalesce(email, 'ANTHONY@NUIMAGEGLASS.COM'), state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-17'::date) where alldata_code = 'ANT004';

-- DADE GSE INC.  (alldata DAD001)
update public.customers set business_name = coalesce(business_name, 'Dade GSE Inc.'), state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-06-12'::date) where alldata_code = 'DAD001';

-- DARYL TAMPLIN  (alldata TAM001)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-21'::date) where alldata_code = 'TAM001';

-- EDWARD KENNEDY  (alldata KEN007)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-16'::date) where alldata_code = 'KEN007';

-- ERIN CRENSHAW  (alldata CRE002)
update public.customers set email = coalesce(email, 'davidanderin0512@gmail.com'), state = coalesce(state, 'FL') where alldata_code = 'CRE002';

-- INTELIGENT SOLUTIONS  (alldata SOL007)
update public.customers set business_name = coalesce(business_name, 'SOLUTIONS'), email = coalesce(email, 'AP@I2SOLUTIONSLLC.COM'), state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-06-02'::date) where alldata_code = 'SOL007';

-- JANDRO DIAZ  (alldata DIA021)
update public.customers set state = coalesce(state, 'FL') where alldata_code = 'DIA021';

-- JENELICE CRUZ  (alldata CRU015)
update public.customers set email = coalesce(email, 'JANDROLAZARODIAZ@GMAIL.COM'), state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-22'::date) where alldata_code = 'CRU015';

-- JOEL JOEL  (alldata JOE001)
update public.customers set state = coalesce(state, 'FL') where alldata_code = 'JOE001';

-- JOSE MENA  (alldata MEN013)
update public.customers set address_line1 = coalesce(address_line1, '8647 PEGASUS DR'), city = coalesce(city, 'Lehigh Acres'), state = coalesce(state, 'FL'), postal_code = coalesce(postal_code, '33971'), last_invoiced = coalesce(last_invoiced, '2026-06-25'::date) where alldata_code = 'MEN013';

-- JOSE RAMIREZ  (alldata RAM024)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-16'::date) where alldata_code = 'RAM024';

-- KHALED ABUELUF  (alldata ABU001)
update public.customers set state = coalesce(state, 'FL') where alldata_code = 'ABU001';

-- KRIS DOURA  (alldata DOU001)
update public.customers set email = coalesce(email, 'KDOURA1@GMAIL.COM'), state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-05-15'::date) where alldata_code = 'DOU001';

-- Keenan Hopple  (alldata HOP001)
update public.customers set state = coalesce(state, 'FL') where alldata_code = 'HOP001';

-- LUCIANO SANCHEZ  (alldata SAN031)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-22'::date) where alldata_code = 'SAN031';

-- MELITON VENTURA  (alldata VEN004)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-17'::date) where alldata_code = 'VEN004';

-- MONTAVIAN TORRANCE  (alldata TOR017)
update public.customers set email = coalesce(email, 'MONTAVIONBOLESTORRANCE@GMAIL.COM'), state = coalesce(state, 'FL') where alldata_code = 'TOR017';

-- OMAR MADRID  (alldata MAD002)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-07-24'::date) where alldata_code = 'MAD002';

-- PEDRO MARTIN  (alldata MAR074)
update public.customers set email = coalesce(email, 'PEDROM0830@HOTMAIL.COM'), state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-05-11'::date) where alldata_code = 'MAR074';

-- PEDRO SANTANA  (alldata SAN032)
update public.customers set last_invoiced = coalesce(last_invoiced, '2026-07-27'::date) where alldata_code = 'SAN032';

-- ROBERTO COROJO  (alldata COR005)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-06-15'::date) where alldata_code = 'COR005';

-- TONY KRUG  (alldata KRU002)
update public.customers set state = coalesce(state, 'FL'), last_invoiced = coalesce(last_invoiced, '2026-05-14'::date) where alldata_code = 'KRU002';

-- TYLER  (alldata TYL002)
update public.customers set state = coalesce(state, 'FL') where alldata_code = 'TYL002';

commit;
