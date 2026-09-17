/* ============================================================
   auth-fetch.js — call an office endpoint AS THE SIGNED-IN USER.

   The client half of `api/_lib/require-user.js`. Those endpoints run with the
   service-role key, so each one now demands the caller's Supabase session:
   `Authorization: Bearer <access_token>` → the server maps it to an ACTIVE
   employees row, or answers 401 and does nothing.

   One shared helper rather than the same four lines at every call site, so
   there is a single place to change when the endpoints move to a stronger
   scheme — and so no site can quietly forget the header.

   IT NEVER SWALLOWS A FAILURE. A rejected call is logged with its status and
   its url. That is a rule written in blood here twice: the push endpoint 403'd
   every front-desk send for months because `firePush` discarded the response,
   and auto-detect hid the same way. The response is returned unchanged, so
   each caller keeps its own success/failure handling.

   Usage:
     const r = await cdAuthFetch(db, '/api/announcement', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(payload),
     });
   ============================================================ */
(function (global) {
  async function cdAuthFetch(db, url, options) {
    const opts = Object.assign({}, options || {});
    const headers = Object.assign({}, opts.headers || {});

    // No session → send the request anyway and let the server refuse it. The
    // alternative (failing locally) would invent a second, client-side auth rule
    // that could drift from the server's. The console line names the real cause,
    // which "HTTP 401" alone does not.
    try {
      const r = await db.auth.getSession();
      const token = r && r.data && r.data.session && r.data.session.access_token;
      if (token) headers.Authorization = 'Bearer ' + token;
      else console.warn('[authFetch] no signed-in session — ' + url + ' will be refused (sign in from CrisData)');
    } catch (e) {
      console.warn('[authFetch] could not read the session for ' + url, e);
    }

    opts.headers = headers;
    const resp = await global.fetch(url, opts);
    if (!resp.ok) console.warn('[authFetch] ' + url + ' → HTTP ' + resp.status);
    return resp;
  }

  global.cdAuthFetch = cdAuthFetch;
})(typeof window !== 'undefined' ? window : globalThis);
