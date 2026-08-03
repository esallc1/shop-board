# How hosting & domains are wired

> Doc: `/docs/wiring/hosting-domains.md`
> Last updated: 2026-08-03 — verified vs commit `01278b1`
> Status: 🟢 current. Verified this session via `vercel` CLI (authed as `esallc1-5351`,
> team `leetransmission-kiki`), live `curl`, and repo code. Items I could not read
> directly (Supabase dashboard, Namecheap DNS panel) are marked **[owner-reported]** or
> **[verify]**.

## 0. In one line
Two Vercel projects on one team; `leetransmissionshop.com` now serves the CrisData front
door (shop-board); KiKi runs on its `.vercel.app` alias only; both custom domains' DNS
lives at Namecheap; both apps share one Supabase project.

## 1. Vercel projects (team `leetransmission-kiki`)
- **shop-board** — repo `esallc1/shop-board`. The CrisData boards (static HTML) + `/api`
  serverless functions. Prod alias: `shop-board-ten.vercel.app` (from `vercel projects ls`).
  Also aliased `shop-board-leetransmission-kiki.vercel.app` (the "stable" alias in
  `api/send-push.js` ALLOWED_ORIGINS).
- **kiki** — repo `esallc1/kiki`, Next.js 16 (App Router). The transmission database.
  Prod alias: `kiki-cyan.vercel.app`.

## 2. Domain → project mapping (current, after today's move)
- **`leetransmissionshop.com` (apex) + `www`** → **shop-board** (MOVED here 2026-08-03,
  from the kiki project). Verified live:
  - apex `https://leetransmissionshop.com` → **308** → `https://www.leetransmissionshop.com/`.
  - `www` root serves `<title>CrisData — Lee Transmission</title>` (HTTP 200) — i.e. the
    **front door `crisdata.html`**, via the root `vercel.json` rewrite `"/" → "/crisdata.html"`.
- **`board.leetransmissionshop.com`** → shop-board (unchanged).
- **kiki** now runs on **`kiki-cyan.vercel.app`** only — no custom domain in active use.
  **[verify / cleanup]** `vercel domains inspect leetransmissionshop.com` still lists the
  apex + `www` under the **kiki** project as well as shop-board. `www` demonstrably serves
  shop-board (CrisData), so shop-board is the active project, but the stale apex+`www`
  attachment on kiki should be removed from the kiki project's Domains settings.
- **`usekiki.app`** → still parked at Namecheap **[owner-reported]**; confirmed **NOT on
  Vercel** (`vercel domains ls` lists only `leetransmissionshop.com`).

## 3. DNS
- **`leetransmissionshop.com`** — registrar "Third Party"; nameservers
  `dns1.registrar-servers.com` / `dns2.registrar-servers.com` = **Namecheap BasicDNS**.
  Vercel "Intended Nameservers: —"; the domain is verified by **A/CNAME records pointing at
  Vercel's edge**, not by delegating nameservers to Vercel. Edge Network: yes.
- **`usekiki.app`** — managed at **Namecheap** **[owner-reported]**, not yet pointed at Vercel.
- No DNS/domain config lives in the repos (root `vercel.json` = rewrites + a cron only; no
  CNAME files; kiki has no `vercel.json`). `.vercel/project.json` is just the project link
  (gitignored).

## 4. PARKED — move KiKi to `usekiki.app` later (NOT done; KiKi currently unused)
Do it in this order so KiKi is never orphaned:
1. Attach `usekiki.app` (+ `www`) to the **kiki** Vercel project; add the A/CNAME records
   Vercel specifies at **Namecheap**. `.app` is **HTTPS-only (HSTS preload)** — wait for
   Vercel to issue SSL before testing (no HTTP fallback).
2. Fix the two hardcoded redirect constants → `https://usekiki.app/auth/set-password`:
   - `kiki/src/app/auth/forgot-password/actions.ts:11`
   - `kiki/src/app/admin/users/actions.ts:55`
   (both currently `const REDIRECT = 'https://kiki-cyan.vercel.app/auth/set-password'`).
3. Add the `usekiki.app` URLs to **Supabase → Auth → URL Configuration** (Redirect URLs +
   Site URL); keep the `kiki-cyan.vercel.app` entries during transition.
- Full step-by-step + rollback is in the migration section of this session's investigation;
  see also [[office-auth]] for the office-side auth URLs.

## 5. Supabase (shared project `hygemiszxwmyrkmhbjub` — used by BOTH boards and kiki)
- Project URL `https://hygemiszxwmyrkmhbjub.supabase.co`, hardcoded across all boards,
  `/api/*`, and kiki (verified in code this session).
- **Auth → Sessions [owner-reported, dashboard 2026-08-03]:** Time-box = **0 (never)**,
  Inactivity timeout = **0 (never)**, Access token expiry = **3600s**. So the **server forces
  no logout**; the only "logged out after a while" is the **client-side §8.8 idle guard
  (120 min)** in `shared/office-identity.js`. Optional server backstop: set Inactivity
  timeout to `7200` (**not currently set**).
- Boards' auth-URL assumptions: office sign-in / set-password flows are documented in
  [[office-auth]] (`office-login.html` + the front door `crisdata.html`). The boards use
  same-origin `getSession()`; no board hardcodes an auth redirect URL (unlike kiki's two
  `REDIRECT` constants in §4).

## Known gaps & open questions (as of 2026-08-03)
- **[verify]** Remove the stale apex + `www` attachment from the **kiki** Vercel project
  (§2) so only shop-board owns them.
- **[owner-reported]** Supabase session settings (§5) and Namecheap DNS state (§3) were not
  read from their dashboards this session — re-confirm if in doubt.
- KiKi → `usekiki.app` migration (§4) is parked, not executed.

## Where it lives in the code
- Front-door rewrite: root `vercel.json` (`"/" → "/crisdata.html"`) → `crisdata.html`.
- Prod-alias allowlist: `api/send-push.js` (ALLOWED_ORIGINS).
- Supabase URL/key: every `*-board.html`, `crisdata.html`, `office-login.html`, `api/*`, and
  `kiki/` (`NEXT_PUBLIC_SUPABASE_URL`).
- KiKi redirect constants: `kiki/src/app/auth/forgot-password/actions.ts:11`,
  `kiki/src/app/admin/users/actions.ts:55`.
- Client-side idle logout: `shared/office-identity.js` (`armIdleLogout`) — see [[office-auth]] §8.8.

## Session change log
- 2026-08-03 — Created. Verified via `vercel` CLI (`domains inspect`, `domains ls`,
  `projects ls`) + live `curl` that `leetransmissionshop.com` + `www` now serve the CrisData
  front door from **shop-board** (apex 308→www; www title "CrisData — Lee Transmission"),
  KiKi runs on `kiki-cyan.vercel.app`, and `usekiki.app` is not on Vercel. Flagged the stale
  apex/`www` attachment still on the kiki project. Recorded Supabase shared-project session
  settings [owner-reported] and the parked KiKi→`usekiki.app` plan.
