# How hosting & domains are wired

> Doc: `/docs/wiring/hosting-domains.md`
> Last updated: 2026-08-19 — **corrected §3.5 and §5 for the sandbox split** (writes on staging are
> safe), added **§3.6: deploys happen by PUSH, never by CLI**, and added **§5.5: the six storage
> buckets**, which this doc never covered — the gap that let the staging sandbox run for a week
> with no buckets at all. Verified vs commit `c26bca9` + the photo-buckets branch.
> Status: 🟢 current. §3.5/§5 re-verified this session against `shared/supabase-config.js`,
> `api/*`, and all 12 pages. Vercel/DNS facts carried forward from the 2026-08-03 session
> (`vercel` CLI as `esallc1-5351`, team `leetransmission-kiki`, live `curl`). Items I could not
> read directly (Supabase dashboard, Namecheap DNS panel) are marked **[owner-reported]** or
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

## 3.5 Staging environment — `test.leetransmissionshop.com` (added 2026-08-11)
A **permanent staging address** that always serves the **`staging`** git branch, so Cris can
test a change on a stable URL that holds a logged-in session before it goes to prod.
- **Domain → branch binding:** `test.leetransmissionshop.com` is attached to the **shop-board**
  Vercel project with **`gitBranch: staging`** (set via the Vercel API — `POST
  /v10/projects/{id}/domains` with `{name, gitBranch:"staging"}`; ownership `verified:true`,
  inherited from the apex). Vercel auto-aliases the domain to the **latest `staging` deployment**.
- **The flow:** feature branch → **merge to `staging`** → GitHub→Vercel integration auto-builds
  → **`test.leetransmissionshop.com`** (and the stable alias
  `shop-board-git-staging-leetransmission-kiki.vercel.app`) → Cris eyeballs → **merge to `main`**
  → the integration auto-builds **production** → **sync `staging` up to `main`** (next bullet).
  (`staging` is long-lived; the production branch is `main`.) **No CLI step anywhere** — see §3.6.
- **Keep staging mirroring prod (post-release sync).** After every push to `main` has finished
  building, staging is brought
  up to main so it always equals **production + whatever feature is still under test**:
  ```
  git checkout staging && git merge --ff-only main && git push origin staging && git checkout main
  ```
  When staging has an in-test feature ahead of main, `--ff-only` fails → use `git merge main`
  (preserves the test commits; never force-reset staging with a feature under test). When nothing
  is under test, staging == main exactly. This is a **manual step in the release routine** today
  (also saved as a CC memory so it runs on every release). A GitHub Action
  (`.github/workflows/sync-staging.yml`, on push to `main`) would automate it, but the repo's git
  PAT lacks the `workflow` scope so CC can't commit workflow files — the file is written for Cris
  to add via the GitHub web UI (or a workflow-scoped token) if full CI automation is wanted.
- **DNS (Namecheap BasicDNS, external):** a **CNAME** — Host `test` → `cname.vercel-dns.com`.
  **Live as of 2026-08-11** — CNAME in place, Vercel config `misconfigured:false`, Let's Encrypt
  cert issued (http-01), HTTPS 200 on all four boards + front door, HTTP→HTTPS 308. (The
  `shop-board-git-staging-…vercel.app` alias also still serves the same deploy.)
- **Login persistence:** office login is `signInWithPassword` (email/password, **no browser
  redirect**) and every board reads `getSession()` **same-origin**, so the Supabase session
  (localStorage key `sb-<project-ref>-auth-token`, scoped to the origin) is **shared across every
  board on `test.*`** — one login holds on advisor / `gm-board` (Manager) / bookkeeping / owner,
  and the front door routes a fifth role (`tech`) to My Numbers. Note the key is **per project
  ref**, so it differs by environment: `sb-efhmefpaijjncwgbvwki-auth-token` on `test.*` (sandbox)
  vs `sb-hygemiszxwmyrkmhbjub-auth-token` on prod — a prod login therefore does **not** carry over
  to staging, which is the intended isolation. Adding `test.*` to Supabase **Auth → Redirect URLs**
  is **not required** for this password login, but was added as future-proofing for any
  redirect-based flow (magic-link / password-reset email / OAuth) — Site URL left unchanged
  (see [[office-auth]]).
- **✅ Isolated DB — writes on staging are SAFE (corrected 2026-08-19).** `test.*` runs on its
  **own** Supabase project (**`efhmefpaijjncwgbvwki`**), a copy of prod — **not** the production
  project. Creating, editing and deleting on `test.leetransmissionshop.com` touches only the
  sandbox: it cannot mutate production data and cannot fire realtime or push to live staff.
  Exercise write-features there freely; that is what it is for.
  The database is chosen **at runtime by hostname** in `shared/supabase-config.js`
  (`pickSupabaseCreds`), which all 12 pages load — prod for the apex / `www` / `board.*` / any
  future `*.leetransmissionshop.com` **except** `test.*`, sandbox for `test.*`, every Vercel
  preview, and `localhost`. Full detail in [[staging-db]]; the page-by-page inventory of what
  loads the switch is in [[page-map]] §8.
  > ⚠ **This bullet previously said the opposite** — that staging shared the prod project and that
  > any write mutated real production data. That was true only before the sandbox split landed
  > (2026-08-18) and is now wrong; it was discouraging exactly the testing staging exists for.

## 3.6 How deploys actually happen — PUSH, NEVER CLI (corrected 2026-08-19)

**The rule, in one line: you deploy by pushing to a branch. Never by running `vercel` on your
own machine.**

| Push to | Builds | Serves |
|---|---|---|
| **`main`** | production | `leetransmissionshop.com`, `www`, `board.*`, the prod Vercel aliases |
| **`staging`** | preview bound to `gitBranch: staging` | `test.leetransmissionshop.com` + `shop-board-git-staging-…vercel.app` |
| any other branch | preview | its own `shop-board-git-<branch>-…` alias only |

**Both are live and automatic. Verified 2026-08-19:**
- **`main` → prod: observed directly.** Two pushes to `main` produced two production deployments,
  seconds after each push, with no `vercel` command run at all.
- **`staging` → `test.*`: verified by SHA.** `test.leetransmissionshop.com/api/version` returns the
  **`staging` branch tip** (`cdea645`) while `main` is far ahead (`c26bca9`). `/api/version` reports
  `VERCEL_GIT_COMMIT_SHA`, and a CLI deploy stamps the *local* HEAD — so a SHA that matches the
  branch and matches no local state can only have come from a git-integration build of that branch.

**Consequences that bite if you forget them:**
1. **Anything pushed to `main` goes live.** There is no "push now, deploy later". Work that must
   not ship yet belongs on a feature branch, not on `main`.
2. **After a push, wait for the build to finish before checking `/api/version`.** Checking
   immediately gives a **false reading** — it returns the *previous* SHA because the new build has
   not swapped in yet, which reads exactly like "the deploy didn't happen". That misreading is what
   made this session believe prod was being held while it was in fact deploying. Give it ~30–60s,
   or watch `vercel ls shop-board --prod` for a `● Ready` row newer than the push.

### Why the old `vercel --prod` habit was wrong — do not bring it back
The previous rule said the GitHub→Vercel webhook "intermittently stops firing" and told you to fall
back to `vercel --prod`. Deploying that way caused two real problems, both diagnosed 2026-08-19:

- **It published internal files.** A CLI deploy uploads the **working directory**, not the git tree.
  Every untracked file not named in `.vercelignore` shipped to a public origin — session handoff
  notes, a marketing business-model doc, `setup_shopboard.sql`, `.claude/`. All were confirmed
  readable at `https://www.leetransmissionshop.com/...` (HTTP 200) before being ignored in `c17db7e`.
  No credential values were exposed, but nothing in that set was app content. A git-integration
  build ships only what is committed and cannot do this.
- **It broke the version stamp.** `/api/version` exists so an installed PWA can detect a new deploy
  ([[page-map]] §3, `shared/version-check.js`). It reads `VERCEL_GIT_COMMIT_SHA`, which a CLI deploy
  populates from whatever your local HEAD happens to be — so it reported a SHA that matched no
  reviewed commit, and a deploy from a dirty or stale tree would have stamped a lie.

If a push genuinely does not produce a deployment, **fix the integration** — do not route around it
with the CLI. `vercel ls shop-board --prod` shows whether a build started; the Vercel dashboard's
Git settings show whether the repo is still connected.

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

## 5. Supabase — TWO projects since the sandbox split (prod + staging)
**Prod** is `hygemiszxwmyrkmhbjub` (`https://hygemiszxwmyrkmhbjub.supabase.co`) — the real
customer database, shared by the boards, `/api/*`, and kiki. **Staging** is
`efhmefpaijjncwgbvwki`, a copy of prod used only by `test.*`, Vercel previews and `localhost`
(§3.5, [[staging-db]]). Which one you get is resolved per surface, and **no board hardcodes a
URL any more** (verified 2026-08-19 — a search for `https://*.supabase.co` across all 12 pages
returns nothing):
- **Boards (client):** `shared/supabase-config.js` picks by **hostname** at runtime; every one of
  the 12 pages loads it and calls `window.cdSupabaseCreds()` ([[page-map]] §8).
- **`/api/*` (server):** `process.env.SUPABASE_URL || 'https://hygemiszxwmyrkmhbjub.supabase.co'`
  — 9 functions use exactly that env-with-prod-fallback shape (e.g. `api/ctm-webhook.js:48`), so
  staging deployments set `SUPABASE_URL` at **Preview** scope to the sandbox while prod leaves it
  unset and lands on the fallback. `SUPABASE_SERVICE_ROLE_KEY` (15 uses) stays server-only.
- **kiki:** its own `NEXT_PUBLIC_SUPABASE_URL`, still prod.
- **Auth → Sessions [owner-reported, dashboard 2026-08-03]:** Time-box = **0 (never)**,
  Inactivity timeout = **0 (never)**, Access token expiry = **3600s**. So the **server forces
  no logout**; the only "logged out after a while" is the **client-side §8.8 idle guard
  (120 min)** in `shared/office-identity.js`. Optional server backstop: set Inactivity
  timeout to `7200` (**not currently set**).
- Boards' auth-URL assumptions: office sign-in / set-password flows are documented in
  [[office-auth]] (`office-login.html` + the front door `crisdata.html`). The boards use
  same-origin `getSession()`; no board hardcodes an auth redirect URL (unlike kiki's two
  `REDIRECT` constants in §4).

## 5.5 Storage — the six buckets (added 2026-08-19)
Storage lives in the **same Supabase project** as the tables, so it splits prod/staging exactly
the same way (§5). Six buckets, defined in one place:
**`migrations/20260819_storage_buckets.sql`** — idempotent, safe on any environment, and the
single answer to "how do I give a new environment storage".

| Bucket | Public | Read as | Used by |
|---|---|---|---|
| `crisdata-attachments` | no | `createSignedUrl` | chat + To-Do attachments, Requests screenshots, RO diagnosis audio, **RO photos AND RO video** |
| `invoice-images` | no | `createSignedUrl` | Capture Invoice, bookkeeping |
| `marketing-content` | no | `createSignedUrl` | the "Catch this moment" FAB → owner Marketing tab |
| `call-recordings` | no | **server-side** signing | recordings cron + `api/recording-links.js` |
| `board-backgrounds` | **yes** | `getPublicUrl` | board settings, shop logo |
| `employee-photos` | **yes** | `getPublicUrl` | employee avatars (`gm-board.html`) |

Two things worth knowing before touching any of it:
- **`call-recordings` carries NO `storage.objects` policies, deliberately.** It is service-role
  only: `api/recording-links.js` signs playback URLs server-side and never accepts or returns a
  `storage_path`. Adding an anon policy there would undo that.
- **`crisdata-attachments` is INSERT + SELECT only** — no delete, for anon or authenticated.
  The boards delete an `attachments` ROW without removing the storage object, so objects
  accumulate. That is the current posture, not an oversight to "fix" casually.
  > ⚠ **And two features have been silently failing on this since July.** `deleteClip`
  > (`my-numbers.html:2044`) and the chat attachment delete (`shared/team-chat.js:1881`) both
  > call `.remove()` on this bucket and both swallow the error. Neither can succeed — there is
  > no delete policy. The row goes, **the bytes stay forever**, and the UI looks correct
  > afterwards, which is why nobody noticed. There is an unknown-size backlog of orphaned
  > objects here. Adding a delete policy would change those two features from "silently orphan"
  > to "actually destroy" — a deliberate decision, not a side-effect. Full write-up:
  > [[ro-photos]] §6.

### 5.5a The project-level upload limit — 100 MB since 2026-08-27

There are **two** size limits and they are not the same thing:

| | where | current value |
|---|---|---|
| **Project global upload limit** | Dashboard → Storage → **Settings** → "Upload file size limit" | **100 MB** on BOTH projects (raised by hand 2026-08-27) |
| **Per-bucket `file_size_limit`** | `storage.buckets.file_size_limit` | **`null` on every bucket** — deliberately |

**A bucket's limit can never exceed the project's** — the dashboard refuses it — so the project
value has to be raised **first**. On the Free plan the project cap is fixed at 50 MB and cannot
be raised at all; both projects sit under the Pro "Lee Transmission" org, which is what makes
100 MB available.

**The bucket limit is left `null` on purpose.** A `null` inherits the project value, so there is
**one** number to keep true instead of two — and an explicit 100 on the bucket would buy nothing
(the project already is the backstop) while making
`migrations/20260819_storage_buckets.sql` start lying: that file creates every bucket with
`(id, name, public)` and no limit, and it is meant to be the single answer to "how do I give a
new environment storage".

⚠ **This is a PROJECT setting, so it raised the ceiling for all six buckets** — Capture Invoice,
the marketing FAB and the rest, not just RO media. Accepted knowingly when RO video shipped
([[ro-photos]] §3b). The alternative — pinning the other five with explicit `file_size_limit`
values — is five more numbers to keep in sync and was refused for the same reason as above.

⚠ **It is NOT visible in `storage.buckets`.** `select id, public, file_size_limit ... ` shows
`null` and always will. The only proof is the dashboard field plus one real >50 MB upload. Do
not read a `null` here as "no limit".

⚠ **AND IT MUST BE RAISED BEFORE THE CODE THAT NEEDS IT DEPLOYS** — on each environment
separately. This is the **reverse** of the deploy-first rule in [[staging-db]] §8.5, and the
reason is which way each ordering fails: code-first means a tech shoots a 70 MB clip, the
client-side check passes, and **Storage rejects it at the old limit** — a day-one failure that
reads exactly like a bug in the new feature.

**Buckets do NOT travel with a schema dump.** `pg_dump --schema-only` of `public` does not carry
`storage.buckets` rows, and neither does the data copy. A new environment has *zero* buckets
until something creates them — which is exactly what bit the staging sandbox on 2026-08-19
(built 2026-08-12 with no buckets; every storage feature on `test.*` silently dead for a week
until RO photo upload tried to write). Run the migration; do not create them by hand. See
[[staging-db]] Step 4a and its Step 6 storage check.

⚠️ **`staging/staging-rls-and-storage.sql` has a phantom bucket in its list.** Its PART 2 loop
iterates `'crisdata-attachments','attachments','employee-photos','board-backgrounds',
'call-recordings','invoice-images','marketing-content'` — and **`attachments` is not a bucket
in this system and never has been.** The table `public.attachments` exists; the *bucket* those
rows point into is `crisdata-attachments`. The stray entry is harmless (it creates a policy for
a bucket that will never exist) but it is a tell that the list was written from memory rather
than from the migrations, and it is the same list Step 4a used to ask you to mirror by hand.
The file is still useful — it grants the permissive sandbox-wide table policies — but the
bucket layout should now come from `migrations/20260819_storage_buckets.sql`, not from there.

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
- 2026-08-19 — **§5.5 added: storage buckets.** This doc described the Supabase project but never
  its STORAGE, and nothing else did either — buckets were side-effects of five unrelated feature
  migrations plus one made by hand in the dashboard (`employee-photos`). The staging sandbox was
  consequently built with ZERO buckets and stayed that way for a week: `staging-rls-and-storage.sql`
  creates storage POLICIES but not BUCKETS, and a policy naming a nonexistent bucket does nothing.
  Every storage feature on `test.*` was silently dead until RO photo upload tried to write. §5.5 now
  lists all six with their flags, read mechanism and consumers, records the two deliberate oddities
  (`call-recordings` has no policies; `crisdata-attachments` has no delete), states that buckets do
  not travel with a schema dump, and flags the phantom `attachments` entry in
  `staging/staging-rls-and-storage.sql`'s bucket list. Fix ships as
  `migrations/20260819_storage_buckets.sql`. Docs only.
- 2026-08-19 — **§3.6 added: deploy by PUSH, never by CLI.** The standing rule said the
  GitHub→Vercel webhook "intermittently stops firing" and to fall back to `vercel --prod`. It is
  false: pushes to `main` build production automatically (observed twice this session, no CLI run),
  and pushes to `staging` build `test.leetransmissionshop.com` (verified by `/api/version` on
  `test.*` returning the `staging` tip while `main` was far ahead). The old habit caused two real
  failures, both recorded in §3.6 so the reason is not forgotten: a CLI deploy uploads the WORKING
  DIRECTORY, which is how untracked internal notes became publicly readable on prod (fixed in
  `c17db7e`), and it stamps `/api/version` from local HEAD rather than a reviewed commit. Also
  documented the false-reading trap: checking `/api/version` immediately after a push returns the
  PREVIOUS SHA and reads exactly like "no deploy happened" — wait for the build. Docs only.
- 2026-08-19 — **Corrected the shared-DB claim (§3.5) and rewrote §5 for two projects.** The doc
  still said staging pointed at the prod Supabase project and that "any WRITE on staging mutates
  real production data" — false since the sandbox split (2026-08-18), and actively discouraging
  the write-testing staging exists for. §3.5 now states the isolation and that writes on `test.*`
  are safe; §5 is retitled for two projects and records how each surface resolves its DB (boards
  via the hostname switch, `/api/*` via env-with-prod-fallback, kiki still prod). Also fixed the
  session-key claim — the localStorage key is per project ref, so a prod login does not carry to
  staging — and the "all four boards" count (five roles route to boards). Verified against
  `shared/supabase-config.js`, `api/ctm-webhook.js:48`, and all 12 pages. Docs only, no code change.
- 2026-08-11 — **Added the permanent staging environment `test.leetransmissionshop.com`** (§3.5):
  a long-lived **`staging`** branch (off `main`), the domain attached to the **shop-board** project
  bound to **`gitBranch: staging`** (Vercel API), and the staging deploy verified serving all four
  boards + front door on `shop-board-git-staging-…vercel.app`. Remaining external steps handed to
  Cris: the Namecheap CNAME (`test` → `cname.vercel-dns.com`) and the Supabase Redirect-URL
  additions (future-proofing; not required for password login). Flagged the shared-prod-DB write
  caveat. Infra/config only — no app-code or data change.
  **Update (same day): both done by Cris — `test.leetransmissionshop.com` is LIVE** (valid
  Let's Encrypt cert; all four boards + front door 200 over HTTPS; origin renders in-browser).
  Final "log in once, session holds on all four" is the owner's to run (password entry).
- 2026-08-11 — **Post-release staging sync** added to the flow (§3.5): after each prod release,
  `staging` is fast-forwarded/merged up to `main` so test.leetransmissionshop.com keeps mirroring
  prod. Manual step for now (CC memory `feedback_staging_sync_on_release`); the GitHub Action to
  automate it couldn't be committed (git PAT missing `workflow` scope) — file handed to Cris.
- 2026-08-03 — Created. Verified via `vercel` CLI (`domains inspect`, `domains ls`,
  `projects ls`) + live `curl` that `leetransmissionshop.com` + `www` now serve the CrisData
  front door from **shop-board** (apex 308→www; www title "CrisData — Lee Transmission"),
  KiKi runs on `kiki-cyan.vercel.app`, and `usekiki.app` is not on Vercel. Flagged the stale
  apex/`www` attachment still on the kiki project. Recorded Supabase shared-project session
  settings [owner-reported] and the parked KiKi→`usekiki.app` plan.
