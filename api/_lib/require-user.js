/* ============================================================
   api/_lib/require-user.js — "is this call coming from a signed-in employee?"

   The reusable caller check for the office endpoints (Security Phase 3). An
   endpoint calls it FIRST, before spending money or touching data, and answers
   401 when it returns null.

   TWO STEPS, and the second one is the point:
     1. Is the bearer token a real, unexpired Supabase session?
        → GET /auth/v1/user with the token. Supabase decides; we never parse or
          trust the JWT ourselves, so an expired or revoked session fails here.
     2. Is that auth user an ACTIVE employee of THIS shop?
        → employees.auth_user_id = <uid> and active = true.

   ⚠ WHY STEP 2 CANNOT BE SKIPPED: the KiKi app shares this Supabase project and
   its auth.users. A KiKi login is a perfectly valid `authenticated` session
   here. "Has a session" therefore proves nothing about CrisData; only the
   employees mapping does. Step 2 also retires access the moment a row is set
   inactive (Josh has an auth user and active = false — he must not pass).

   ⚠ is_test is NOT filtered, on purpose. The sandbox's ZZ office accounts are
   `is_test = true` and active, and they are how test.leetransmissionshop.com is
   tested. Filtering them would make staging untestable while telling us nothing
   about prod (there the ZZ rows are inactive, so they fail on `active` anyway).

   Returns { id, name, role } for a good caller, or null. Never throws, and
   never says WHICH step failed — the endpoint answers one flat 401.

   Usage:
     import { requireUser } from './_lib/require-user.js';
     const employee = await requireUser(req);
     if (!employee) return res.status(401).json({ error: 'unauthorized' });
   ============================================================ */

// Same env-with-prod-fallback shape as every other function here: staging
// deployments set SUPABASE_URL (Preview env) to the sandbox project; prod leaves
// it unset and falls back to the prod project.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hygemiszxwmyrkmhbjub.supabase.co';
// The publishable key is only the API gateway key for the /auth/v1/user call —
// the USER's token in Authorization is what identifies them. Public by design
// (it ships in every page), and it grants nothing on its own.
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_8o9Df7K_DGpQ3s6yUCDq-A_HMh4Zllo';

// Pull the bearer token out of the Authorization header. Pure + exported so the
// header parsing is locked by tests. Returns the token, or null.
export function bearerToken(req) {
  const raw = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token ? token : null;
}

/**
 * Resolve the caller to an active employee, or null.
 * @param {object} req                     the Vercel request
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl]      injectable fetch (tests)
 * @returns {Promise<{id: string, name: string, role: string}|null>}
 */
export async function requireUser(req, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const token = bearerToken(req);
  if (!token) return null;

  // The employees lookup needs the service-role key: after the Phase 3 RLS
  // cutover the roster is not readable with the publishable key. Fail CLOSED and
  // loudly if it is missing — never fall back to a weaker check.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    try { console.error('[require-user] SUPABASE_SERVICE_ROLE_KEY is not set — refusing every caller.'); } catch (e) {}
    return null;
  }

  // ── 1. Is the token a live Supabase session? ──────────────────────────────
  let userId = null;
  try {
    const r = await doFetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;                       // expired / revoked / junk
    const user = await r.json();
    userId = user && user.id;
    if (!userId || typeof userId !== 'string') return null;
  } catch (e) {
    try { console.error('[require-user] token check failed', e && e.message); } catch (e2) {}
    return null;
  }

  // ── 2. Is that user an active employee of this shop? ──────────────────────
  try {
    const url = `${SUPABASE_URL}/rest/v1/employees` +
      `?auth_user_id=eq.${encodeURIComponent(userId)}` +
      `&active=is.true&select=id,name,role&limit=2`;
    const r = await doFetch(url, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    // Exactly one row, or nobody. auth_user_id has a unique partial index, so
    // two matches means the roster is broken — resolving to NOBODY is the safe
    // reading, the same rule the boards use for an ambiguous phone.
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const e = rows[0];
    if (!e || !e.id) return null;
    return { id: e.id, name: e.name, role: e.role };
  } catch (e) {
    try { console.error('[require-user] employee lookup failed', e && e.message); } catch (e2) {}
    return null;
  }
}
