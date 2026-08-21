/* ============================================================
   office-identity.js — the dual-identity viewer resolver (office-auth §8.3 / 8.6a).

   ONE resolver every office board calls to answer "who is viewing this board?"
   in a way that works for BOTH sign-in paths:

     (a) AUTH  — a Supabase office-login session (getSession → auth_user_id →
                 employees row). Same lookup office-login.html does (:193/:200).
     (b) PHONE — else the phone/PIN path: the ?u=phone&p=pin passthrough from
                 crisdata.html (validated by pin [+ role]), or the persisted
                 per-board session value in localStorage.

   Returns { employee_id, name, role, photo_url, via } (via = 'auth' | 'phone'),
   or null when neither resolves — in which case the board behaves exactly as it
   does today (greeting hidden, per-viewer features show "reopen from CrisData").

   TWO THINGS CHANGED 2026-08-21 (office-auth §1c, staging-db §7):
     • The persisted value is now the employee's UUID, not their phone. Same key
       NAME, so no migration; a legacy phone value resolves once and is rewritten
       as the id. A phone is mutable, reusable and NOT unique — an id is none of
       those, so retiring or hiring can no longer break a live session.
     • Every phone lookup filters `active` and treats a MULTI-ROW match as an
       audible failure (console.error + a visible line in the greeting slot)
       instead of `.maybeSingle()`'s silent null. Two active employees sharing a
       phone used to resolve to nobody and the board just carried on.

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

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ── AMBIGUITY IS LOUD (office-auth §1c) ────────────────────────────────────
  // `employees.phone` is not unique. The old code ended every phone lookup in
  // `.maybeSingle()`, which ERRORS on a multi-row match instead of picking one —
  // so two rows sharing a phone resolved to `null`, and the board carried on with
  // no identity, no greeting and NULL name-stamps. An absence that looks like a
  // fresh visit. Never let that happen quietly again: say so in the console, and
  // put a visible line where the greeting would have been.
  //
  // This can only inform. It never grants access and never blocks the board.
  function reportAmbiguous(phone, rows) {
    var msg = '[OfficeIdentity] AMBIGUOUS phone ' + phone + ' matches ' + rows +
              ' active employees — resolving to NOBODY. Retire the duplicate row; ' +
              'see docs/wiring/office-auth.md §1c.';
    try { console.error(msg); } catch (e) {}
    try {
      var wrap = document.getElementById('greetingWrap');
      if (wrap) {
        wrap.textContent = 'Sign-in is ambiguous — two staff records share this phone. Tell Cristian.';
        wrap.style.display = 'flex';
        wrap.style.color = '#b42318';
      }
    } catch (e) {}
  }

  // Look an employee up by phone among ACTIVE rows, treating >1 match as a hard,
  // AUDIBLE failure rather than a silent null. Returns a row, or null.
  async function employeeByPhone(db, phone) {
    var r = await db.from('employees').select(EMP_COLS).eq('phone', phone)
      .eq('active', true).limit(2);
    if (r.error) { try { console.error('[OfficeIdentity] phone lookup failed', r.error); } catch (e) {} return null; }
    var rows = r.data || [];
    if (rows.length > 1) { reportAmbiguous(phone, rows.length); return null; }
    return rows[0] || null;
  }

  // (b) Phone/PIN resolution — fresh ?u/p passthrough (pin [+ role] validated,
  // persisted, URL cleaned) → else the persisted per-board session value.
  //
  // WHAT IS PERSISTED CHANGED: the storage key now holds the employee's UUID, not
  // their phone. A phone is mutable, reusable and — as above — not unique; an id
  // is none of those. The key NAME is unchanged (`advisorBoardPhone` et al.) so no
  // second migration is needed, and a legacy phone value still works: it resolves
  // once by phone and is then REWRITTEN as the id, so sessions upgrade themselves
  // on next load instead of breaking.
  //
  // Returns an employee row (EMP_COLS) or null.
  async function resolvePhone(opts) {
    var db = opts.db;
    var key = opts.sessionPhoneKey || null;
    var params = new URLSearchParams(window.location.search);
    var passPhone = params.get('u');
    var passPin = params.get('p');

    if (passPhone && passPin) {
      var q = db.from('employees').select(EMP_COLS)
        .eq('phone', passPhone).eq('pin', passPin).eq('active', true);
      if (opts.expectedRole) q = q.eq('role', opts.expectedRole);
      var res = await q.limit(2);
      var hits = (res && res.data) || [];
      if (hits.length > 1) { reportAmbiguous(passPhone, hits.length); return null; }
      if (hits.length === 1) {
        if (key) localStorage.setItem(key, hits[0].id);      // persist the ID
        window.history.replaceState({}, '', window.location.pathname);
        return hits[0];
      }
    }

    if (key) {
      var persisted = localStorage.getItem(key);
      if (persisted) {
        if (UUID_RE.test(persisted)) {
          var byId = await db.from('employees').select(EMP_COLS)
            .eq('id', persisted).eq('active', true).maybeSingle();
          if (byId.error) { try { console.error('[OfficeIdentity] id lookup failed', byId.error); } catch (e) {} return null; }
          return byId.data || null;
        }
        // Legacy value: a phone. Resolve it, then upgrade the key to the id.
        var row = await employeeByPhone(db, persisted);
        if (row) { try { localStorage.setItem(key, row.id); } catch (e) {} }
        return row;
      }
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

    // Arm the shared idle auto-logout the moment a board resolves identity — this
    // is how owner/gm/advisor/bookkeeping get the 120-min timer with no per-board
    // code. Idempotent (arms once per page); uses this board's phone key so the
    // persisted phone is dropped alongside any auth session on timeout.
    armIdleLogout({ db: db, storageKey: opts.sessionPhoneKey });

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

    // (b) PHONE/PIN branch. resolvePhone now returns the employee ROW (already
    // filtered to active, already loud on an ambiguous match), so there is no
    // second lookup here to re-introduce the silent-null bug.
    var row = await resolvePhone(opts);
    if (row) {
      return {
        employee_id: row.id, name: row.name, role: row.role,
        photo_url: row.photo_url || null, via: 'phone',
      };
    }
    return null;
  }

  // ── Idle auto-logout guard (office-auth §8) ──────────────────────────────
  // The single, centralized 120-minute inactivity timer that used to be
  // copy-pasted into each board. On timeout it ENDS the session only: signs out
  // any Supabase auth session, drops the board's persisted phone key, and returns
  // to the login door. It can never grant access — additive/safety only.
  //
  // resolve() auto-arms this for every board that includes this script (owner,
  // gm, advisor, bookkeeping). Other pages (e.g. my-numbers, whose "session" is a
  // tech-id, not an auth session) can arm it directly with their own storageKey.
  var IDLE_LIMIT_MS = 120 * 60 * 1000;   // 120 minutes — identical to the old per-board value
  var IDLE_CHECK_MS = 30 * 1000;         // poll cadence
  var idleArmed = false;                 // module-level: arm once per page load

  function armIdleLogout(opts) {
    opts = opts || {};
    if (idleArmed) return;                 // no duplicate listeners/timers on re-init
    if (typeof window === 'undefined') return;
    // Local dev: never arm the idle timer, so the door stays open while working on a
    // local copy (localhost / 127.0.0.1 / file:// / *.local). Prod is unaffected —
    // the 120-min idle logout still applies on leetransmissionshop.com.
    var host = (window.location && window.location.hostname) || '';
    if (host === 'localhost' || host === '127.0.0.1' || host === '' || /\.local$/.test(host)) return;
    var db = opts.db;
    if (!db || !db.auth) return;           // need a client that can signOut
    idleArmed = true;

    var storageKey = opts.storageKey || null;
    var redirectTo = opts.redirectTo || 'crisdata.html';
    var limitMs = opts.limitMs || IDLE_LIMIT_MS;
    var checkMs = opts.checkMs || IDLE_CHECK_MS;
    var lastActivity = Date.now();
    var loggingOut = false;                // guard against a double redirect

    function bump() { lastActivity = Date.now(); }
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(function (evt) {
      window.addEventListener(evt, bump, { passive: true });
    });

    async function logOut() {
      if (loggingOut) return;
      loggingOut = true;
      try { await db.auth.signOut(); } catch (e) {}
      try { if (storageKey) localStorage.removeItem(storageKey); } catch (e) {}
      window.location.href = redirectTo;
    }

    setInterval(function () {
      if (!loggingOut && Date.now() - lastActivity >= limitMs) logOut();
    }, checkMs);
  }

  global.OfficeIdentity = {
    resolve: resolve,
    // ⚠ SIGNATURE CHANGED 2026-08-21: resolvePhone now resolves to an employee
    // ROW ({id,name,photo_url,role}) or null — it used to return a phone string.
    // Nothing outside this file called it; check before assuming otherwise.
    resolvePhone: resolvePhone,
    armIdleLogout: armIdleLogout,
  };
})(window);
