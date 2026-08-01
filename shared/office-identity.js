/* ============================================================
   office-identity.js — the dual-identity viewer resolver (office-auth §8.3 / 8.6a).

   ONE resolver every office board calls to answer "who is viewing this board?"
   in a way that works for BOTH sign-in paths:

     (a) AUTH  — a Supabase office-login session (getSession → auth_user_id →
                 employees row). Same lookup office-login.html does (:193/:200).
     (b) PHONE — else today's phone/PIN path, UNCHANGED: the ?u=phone&p=pin
                 passthrough from crisdata.html (validated by pin [+ role]) or the
                 persisted per-board phone in localStorage.

   Returns { employee_id, name, role, photo_url, via } (via = 'auth' | 'phone'),
   or null when neither resolves — in which case the board behaves exactly as it
   does today (greeting hidden, per-viewer features show "reopen from CrisData").

   Purely ADDITIVE: the auth branch is tried first; if there is no session (or the
   session isn't linked to an employee yet) it falls through to the existing phone
   path, so PIN users are wholly unaffected. Techs stay on phone permanently.

   Usage (per board):
     const who = await OfficeIdentity.resolve({
       db, sessionPhoneKey: 'ownerBoardPhone', expectedRole: 'owner',
     });
     if (who) applyIdentity(who);      // set CURRENT_EMPLOYEE_ID / CHAT_IDENTITY
   ============================================================ */
(function (global) {
  var EMP_COLS = 'id, name, photo_url, role';

  // (b) Phone/PIN resolution — mirrors the boards' existing captureSessionAndGreet
  // logic exactly: fresh ?u/p passthrough (pin [+ role] validated, persisted, URL
  // cleaned) → else the persisted per-board phone. Returns a phone string or null.
  async function resolvePhone(opts) {
    var db = opts.db;
    var key = opts.sessionPhoneKey || null;
    var params = new URLSearchParams(window.location.search);
    var passPhone = params.get('u');
    var passPin = params.get('p');

    if (passPhone && passPin) {
      var q = db.from('employees').select('phone')
        .eq('phone', passPhone).eq('pin', passPin).eq('active', true);
      if (opts.expectedRole) q = q.eq('role', opts.expectedRole);
      var res = await q.maybeSingle();
      if (res.data) {
        if (key) localStorage.setItem(key, res.data.phone);
        window.history.replaceState({}, '', window.location.pathname);
        return res.data.phone;
      }
    }
    if (key) {
      var persisted = localStorage.getItem(key);
      if (persisted) return persisted;
    }
    return null;
  }

  // Resolve the current viewer. Auth first, phone fallback. Never throws — an
  // auth lookup failure (no session / offline / client without GoTrue) quietly
  // falls through to the phone path.
  async function resolve(opts) {
    opts = opts || {};
    var db = opts.db;
    if (!db) return null;

    // (a) AUTH branch — a live office-login session mapped to an employee row.
    try {
      var sess = await db.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (user && user.id) {
        var a = await db.from('employees').select(EMP_COLS)
          .eq('auth_user_id', user.id).maybeSingle();
        if (a.data) {
          return {
            employee_id: a.data.id, name: a.data.name, role: a.data.role,
            photo_url: a.data.photo_url || null, via: 'auth',
          };
        }
        // Signed in but not linked to an employee yet → fall through to phone.
      }
    } catch (e) {
      // no auth session / client → phone path
    }

    // (b) PHONE/PIN branch — today's path, unchanged.
    var phone = await resolvePhone(opts);
    if (phone) {
      var p = await db.from('employees').select(EMP_COLS).eq('phone', phone).maybeSingle();
      if (p.data) {
        return {
          employee_id: p.data.id, name: p.data.name, role: p.data.role,
          photo_url: p.data.photo_url || null, via: 'phone',
        };
      }
    }
    return null;
  }

  global.OfficeIdentity = { resolve: resolve, resolvePhone: resolvePhone };
})(window);
