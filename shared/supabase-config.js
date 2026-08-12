/* ============================================================================
   supabase-config.js — ONE source of truth for which Supabase project each
   surface talks to, chosen at runtime by hostname.

   WHY: the boards are static HTML with the Supabase URL + anon key hardcoded, and
   `staging` is the same code as `main` (just a branch). So we cannot point staging
   at a different DB with "env vars" on the client. Instead this file ships on BOTH
   branches, identical, and self-selects by hostname — so main↔staging merges never
   conflict and can never cross credentials.

   RULE (prod is protected; staging is the safe default):
     • PROD  → any *.leetransmissionshop.com EXCEPT test.*  (apex / www / board),
               plus the known prod Vercel aliases.
     • STAGING → everything else: test.leetransmissionshop.com, every Vercel
               preview (shop-board-git-*), and localhost.
   A brand-new prod subdomain is automatically PROD; only `test.` is carved out to
   staging. The anon/publishable keys are public (they already ship in the HTML),
   so embedding both is fine.

   Loaded before each board's own <script>:
     <script src="shared/supabase-config.js"></script>
   then the board does:
     const { url: SUPABASE_URL, key: SUPABASE_KEY } = window.cdSupabaseCreds();
   ============================================================================ */
(function (root) {
  'use strict';

  // ── Production project (hygemiszxwmyrkmhbjub) — the real customer database ──
  var PROD = {
    env: 'production',
    url: 'https://hygemiszxwmyrkmhbjub.supabase.co',
    key: 'sb_publishable_8o9Df7K_DGpQ3s6yUCDq-A_HMh4Zllo',
  };

  // ── Staging project — a SEPARATE database used only by test.* and previews ──
  // TODO(staging): paste the NEW staging project's Project URL + anon/publishable
  // key here (Supabase → Project Settings → API). Until these are filled in, any
  // non-prod surface (test.*, previews, localhost) will fail to reach a DB — which
  // is intentional: better a loud failure than a silent fall-through to prod.
  var STAGING = {
    env: 'staging',
    url: 'https://efhmefpaijjncwgbvwki.supabase.co',
    key: 'sb_publishable_XuOUl1VGwI1kHx3MAET6MA_PjBzbGNX',
  };

  // Known prod Vercel aliases (the custom domain is the everyday prod surface;
  // these cover hitting the prod deployment directly).
  var PROD_VERCEL_ALIASES = {
    'shop-board-ten.vercel.app': 1,
    'shop-board-leetransmission-kiki.vercel.app': 1,
  };

  function endsWith(s, suffix) {
    return s.length >= suffix.length && s.slice(s.length - suffix.length) === suffix;
  }

  // Pure + testable: hostname → creds object. No DOM, no globals.
  // PROD = the apex or any *.leetransmissionshop.com EXCEPT test.*, plus the known
  // prod Vercel aliases. Everything else (test.*, previews, localhost) → STAGING.
  function pickSupabaseCreds(hostname) {
    var h = String(hostname == null ? '' : hostname).toLowerCase();
    var isCustomProd =
      (h === 'leetransmissionshop.com' || endsWith(h, '.leetransmissionshop.com'))
      && h !== 'test.leetransmissionshop.com';
    var isProd = isCustomProd || PROD_VERCEL_ALIASES.hasOwnProperty(h);
    return isProd ? PROD : STAGING;
  }

  // Browser: expose the resolver, a resolved snapshot for the current origin, and
  // the pure selector (the last one lets the test drive arbitrary hostnames).
  if (root) {
    root.cdPickSupabaseCreds = pickSupabaseCreds;
    if (root.location) {
      root.cdSupabaseCreds = function () { return pickSupabaseCreds(root.location.hostname); };
      root.CD_SUPABASE = root.cdSupabaseCreds();
    }
  }
})(typeof window !== 'undefined' ? window : this);
