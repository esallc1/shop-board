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

   A 401 SAYS WHAT TO DO (Cris, 2026-09-23). The browser keeps a CrisData
   sign-in per ADDRESS: signing in on www does nothing for board.* — and a board
   can still greet someone from an old phone/ID identity with no sign-in behind
   it. Every login-protected action then answered a bare "unauthorized" (Kevin,
   Report a change, board.*). Now:
     • cdAuthFetch shows ONE page-level notice on any 401 — so every caller,
       including the silent ones (recording playback just hid its buttons) and
       any future endpoint, gets the message for free;
     • cdAuthErrorText(status, fallback) gives screens that print their own
       error the SAME sentence (CD_SIGNIN_LOST) for a 401, their own text else.
   Nothing here clears a form: callers keep what the user typed.

   Usage:
     const r = await cdAuthFetch(db, '/api/announcement', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(payload),
     });
     if (!r.ok) showError(cdAuthErrorText(r.status, 'Could not post: HTTP ' + r.status));
   ============================================================ */
(function (global) {
  // The exact words (Cris). Also in shared/messenger-tray-logic.js (a pure module
  // with no window) — a test keeps the two identical.
  var CD_SIGNIN_LOST = "Your CrisData sign-in isn't active on this page — log out and sign in again.";

  // A 401 → the sentence above; anything else → the caller's own text.
  function cdAuthErrorText(status, fallback) {
    return Number(status) === 401 ? CD_SIGNIN_LOST : (fallback == null ? '' : String(fallback));
  }

  // One notice per page, top-centre, dismissible, shown again only after a later
  // 401 once dismissed. z 4800: above the call card (4000), modals, the mobile
  // sidebar (4500) and board-fault (4700); below Team Chat toasts (9999).
  // No DOM (tests, workers) → no-op.
  function cdShowSigninNotice() {
    var doc = global.document;
    if (!doc || !doc.body || typeof doc.createElement !== 'function') return false;
    var el = doc.getElementById('cdSigninNotice');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'cdSigninNotice';
      el.setAttribute('role', 'alert');
      el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:4800;' +
        'max-width:min(560px,calc(100vw - 32px));display:flex;align-items:center;gap:10px;' +
        'padding:10px 12px 10px 14px;border-radius:10px;background:#fff1f1;border:1px solid #f3b4b4;' +
        'color:#b42318;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'box-shadow:0 8px 24px rgba(20,22,40,.18)';
      var txt = doc.createElement('span');
      txt.textContent = '⚠ ' + CD_SIGNIN_LOST;
      var x = doc.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Dismiss');
      x.textContent = '×';
      x.style.cssText = 'border:none;background:none;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:0 2px';
      x.addEventListener('click', function () { el.style.display = 'none'; });
      el.appendChild(txt); el.appendChild(x);
      doc.body.appendChild(el);
    }
    el.style.display = 'flex';
    return true;
  }

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
    if (resp.status === 401) { try { cdShowSigninNotice(); } catch (e) {} }
    return resp;
  }

  global.cdAuthFetch = cdAuthFetch;
  global.cdAuthErrorText = cdAuthErrorText;
  global.cdShowSigninNotice = cdShowSigninNotice;
  global.CD_SIGNIN_LOST = CD_SIGNIN_LOST;
})(typeof window !== 'undefined' ? window : globalThis);
