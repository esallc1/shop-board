/* ============================================================
   push.js — Web Push permission + subscription capture (sub-slices 2b + 2d).

   Sending lives in api/send-push.js (2c). This module:
   • detects push support / iOS-install state,
   • on a user gesture, requests Notification permission and subscribes via
     PushManager using the VAPID PUBLIC key below,
   • UPSERTs the subscription into push_subscriptions (endpoint PK),
   • renders a light-theme "nudge until enabled" banner on the office boards,
   • 2d — SELF-HEALS on every open (silently re-upserts a granted subscription,
     re-subscribing if iOS dropped it) and offers a quiet "Reconnect
     notifications" backstop when notifications are on.

   Identity (subscriber_name/role) is read LIVE via the board's getIdentity
   getter — never a snapshot — same pattern as team-chat.js. Degrades
   gracefully if push_subscriptions isn't migrated yet (PGRST205 → off).
   No in-app on/off toggle — on/off lives in iOS Settings.

   Mount once per board:  initPush({ db, getIdentity })
   ============================================================ */
(function (global) {
  // VAPID PUBLIC key — meant to be public (shipped to the client). The matching
  // PRIVATE key lives ONLY in the Vercel env (VAPID_PRIVATE_KEY) for the 2c sender.
  var VAPID_PUBLIC = 'BByOPsrzKI55qegn0RENJRoA0ijuf4Axb3rVpt4UJ7SYBlqRSMJiITi1JZhAyayPwHHcBU3u9ygvwF2Kvf--AD8';

  var _db = null;
  var _getIdentity = function () { return {}; };
  var _dismissed = false;         // in-memory only → nudge returns on reload/next session
  var _tableAvailable = true;     // flips false if push_subscriptions is unmigrated

  // ── capability detection ──
  function pushSupported() {
    return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  }
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iP(hone|ad|od)/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS masquerading as Mac
  }
  function isInstalledStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true; // iOS
  }

  // 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on'
  async function getPushState() {
    if (isIOS() && !isInstalledStandalone()) return 'needs-install';
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission !== 'granted') return 'off';
    // granted — 'on' only when we actually hold a subscription AND can persist it
    if (!_tableAvailable) return 'off';
    try {
      var reg = await navigator.serviceWorker.getRegistration('/');
      var sub = reg && await reg.pushManager.getSubscription();
      return sub ? 'on' : 'off';
    } catch (e) { return 'off'; }
  }

  function isMissingTable(err) {
    var code = (err && err.code) || '', msg = (err && err.message) || '';
    return code === '42P01' || code === 'PGRST205' ||
      /relation .* does not exist/i.test(msg) || /could not find the table/i.test(msg);
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function upsertSubscription(sub) {
    if (!_db || !_tableAvailable) return false;
    var j = sub.toJSON() || {};
    var id = _getIdentity() || {};
    var row = {
      endpoint: sub.endpoint,
      p256dh: (j.keys && j.keys.p256dh) || null,
      auth: (j.keys && j.keys.auth) || null,
      subscriber_role: id.role || null,
      subscriber_name: id.name || null,
      user_agent: navigator.userAgent || null,
      last_seen_at: new Date().toISOString(),
    };
    var res = await _db.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
    if (res.error) {
      if (isMissingTable(res.error)) { _tableAvailable = false; return false; }
      console.warn('[Push] subscription upsert failed', res.error.message);
      return false;
    }
    return true;
  }

  // MUST be called from a user gesture. Returns the resulting state.
  async function enablePush() {
    if (isIOS() && !isInstalledStandalone()) return 'needs-install';
    if (!pushSupported()) return 'unsupported';

    var perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm === 'denied') return 'denied';
    if (perm !== 'granted') return 'off';

    var reg = await navigator.serviceWorker.getRegistration('/') || await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
      });
    }
    var stored = await upsertSubscription(sub);   // refreshes last_seen_at on re-enable
    return stored ? 'on' : 'off';                 // table missing → treat as off (no crash)
  }

  // Optional: turn it back off (unsubscribe + drop the row).
  async function disablePush() {
    try {
      var reg = await navigator.serviceWorker.getRegistration('/');
      var sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        var endpoint = sub.endpoint;
        await sub.unsubscribe();
        if (_db && _tableAvailable) {
          var res = await _db.from('push_subscriptions').delete().eq('endpoint', endpoint);
          if (res.error && isMissingTable(res.error)) _tableAvailable = false;
        }
      }
    } catch (e) { console.warn('[Push] disable failed', e); }
    return 'off';
  }

  // ── nudge banner (light theme, slim, dismiss-per-session) ──
  var STYLE = [
    '.push-nudge{',
    '  display:flex; align-items:center; gap:12px; flex-wrap:wrap;',
    '  margin:0 0 16px; padding:10px 14px; border-radius:10px;',
    '  background:#eef0ff; border:1px solid #d4d7fb; color:#2a2d5a;',
    '  font:600 0.82rem/1.4 "Segoe UI",system-ui,-apple-system,sans-serif;',
    '}',
    '.push-nudge .pn-ico{ font-size:1.05rem; line-height:1; flex:0 0 auto; }',
    '.push-nudge .pn-text{ flex:1 1 220px; font-weight:600; }',
    '.push-nudge .pn-text small{ display:block; font-weight:500; color:#5a5e88; margin-top:2px; }',
    '.push-nudge .pn-btn{',
    '  flex:0 0 auto; border:none; border-radius:8px; cursor:pointer;',
    '  background:#5b5ef4; color:#fff; font:700 0.8rem/1 inherit; padding:9px 14px;',
    '}',
    '.push-nudge .pn-btn:hover{ background:#4a4ddb; }',
    '.push-nudge .pn-x{',
    '  flex:0 0 auto; border:none; background:transparent; cursor:pointer;',
    '  color:#7a7ea8; font-size:1.05rem; line-height:1; padding:4px 6px; border-radius:6px;',
    '}',
    '.push-nudge .pn-x:hover{ background:#e0e3fb; color:#2a2d5a; }',
    '.push-nudge.pn-denied{ background:#fdecec; border-color:#f3c9c9; color:#7a2a2a; }',
    '.push-nudge.pn-denied .pn-x{ color:#b06a6a; }',
    '.push-nudge.pn-denied .pn-x:hover{ background:#f6d6d6; color:#7a2a2a; }',
    // quiet "Reconnect notifications" backstop (shown when state is 'on')
    '.push-reconnect{',
    '  display:flex; align-items:center; gap:8px; flex-wrap:wrap;',
    '  margin:0 0 12px; padding:6px 11px; border-radius:8px;',
    '  background:#f5f6fa; border:1px solid #e7e9f2; color:#8c93a8;',
    '  font:600 0.72rem/1.4 "Segoe UI",system-ui,-apple-system,sans-serif;',
    '}',
    '.push-reconnect .pr-dot{ font-size:0.82rem; opacity:.75; flex:0 0 auto; }',
    '.push-reconnect .pr-label{ color:#8c93a8; font-weight:600; }',
    '.push-reconnect .pr-link{',
    '  border:none; background:transparent; cursor:pointer; padding:2px 3px;',
    '  color:#5b5ef4; font:700 0.72rem/1 inherit; text-decoration:underline;',
    '}',
    '.push-reconnect .pr-link:hover{ color:#4a4ddb; }',
    '.push-reconnect .pr-link:disabled{ color:#8c93a8; cursor:default; text-decoration:none; }',
    '.push-reconnect .pr-msg{ color:#0b7a52; font-weight:600; }',
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('push-nudge-style')) return;
    var s = document.createElement('style');
    s.id = 'push-nudge-style';
    s.textContent = STYLE;
    (document.head || document.documentElement).appendChild(s);
  }

  function mountPoint() {
    return document.querySelector('.content') || document.querySelector('.main-area') || document.body;
  }
  function removeBanner() {
    var b = document.getElementById('push-nudge');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }
  function removeReconnect() {
    var b = document.getElementById('push-reconnect');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  var COPY = {
    'needs-install': {
      cls: '', ico: '🔔',
      text: 'Add CrisData to your home screen to get notifications',
      sub: 'Tap Share → Add to Home Screen, then open it from your home screen.',
      btn: null,
    },
    'off': {
      cls: '', ico: '🔔',
      text: "Turn on notifications so you don't miss messages",
      sub: null, btn: 'Enable notifications',
    },
    'denied': {
      cls: 'pn-denied', ico: '🔕',
      text: 'Notifications are blocked',
      sub: "Turn them back on in your phone's settings for this app.",
      btn: null,
    },
  };

  // Single source of truth for the push UI. Re-checks the live state and shows
  // exactly one of: the quiet Reconnect backstop ('on'), the nudge banner
  // ('off'/'needs-install'/'denied'), or nothing ('unsupported'). Called after
  // every enable/reconnect/self-heal so success auto-hides the banner.
  async function renderPushUI() {
    var state = await getPushState();
    removeBanner();
    removeReconnect();
    if (state === 'unsupported') return;
    if (state === 'on') { renderReconnect(); return; }   // notifications on → quiet backstop only
    if (_dismissed) return;                               // banner dismissed this session
    renderNudgeBanner(state);
  }

  function renderNudgeBanner(state) {
    var c = COPY[state];
    if (!c) return;
    injectStyles();
    var el = document.createElement('div');
    el.id = 'push-nudge';
    el.className = 'push-nudge' + (c.cls ? ' ' + c.cls : '');
    el.innerHTML =
      '<span class="pn-ico">' + c.ico + '</span>' +
      '<span class="pn-text">' + escapeHtml(c.text) +
        (c.sub ? '<small>' + escapeHtml(c.sub) + '</small>' : '') + '</span>' +
      (c.btn ? '<button type="button" class="pn-btn" id="pn-enable">' + escapeHtml(c.btn) + '</button>' : '') +
      '<button type="button" class="pn-x" id="pn-dismiss" aria-label="Dismiss">×</button>';

    var mp = mountPoint();
    mp.insertBefore(el, mp.firstChild);

    var enableBtn = el.querySelector('#pn-enable');
    if (enableBtn) {
      enableBtn.addEventListener('click', async function () {   // the required user gesture
        enableBtn.disabled = true;
        enableBtn.textContent = 'Enabling…';
        try { await enablePush(); } catch (e) { console.warn('[Push] enable failed', e); }
        renderPushUI();   // success → state 'on' → banner auto-hides + Reconnect shows
      });
    }
    el.querySelector('#pn-dismiss').addEventListener('click', function () {
      _dismissed = true;   // hidden this page-load; returns on reload / next session
      removeBanner();
    });
  }

  // CHANGE 2 (2d): the quiet, always-available "Reconnect notifications"
  // backstop, shown whenever notifications are ON. It's the manual counterpart
  // to the invisible self-heal — for the "iOS Settings show ON but no buzz"
  // case, tapping it re-runs the full subscribe + upsert.
  function renderReconnect() {
    injectStyles();
    var el = document.createElement('div');
    el.id = 'push-reconnect';
    el.className = 'push-reconnect';
    el.innerHTML =
      '<span class="pr-dot">🔔</span>' +
      '<span class="pr-label">Notifications on</span>' +
      '<button type="button" class="pr-link" id="pr-reconnect">Reconnect notifications</button>' +
      '<span class="pr-msg" id="pr-msg"></span>';
    var mp = mountPoint();
    mp.insertBefore(el, mp.firstChild);
    el.querySelector('#pr-reconnect').addEventListener('click', onReconnectClick);
  }

  async function onReconnectClick() {
    var btn = document.getElementById('pr-reconnect');
    var msg = document.getElementById('pr-msg');
    if (btn) { btn.disabled = true; btn.textContent = 'Reconnecting…'; }
    if (msg) msg.textContent = '';
    var result = 'off';
    try { result = await enablePush(); }   // permission already granted → re-subscribe + re-upsert
    catch (e) { console.warn('[Push] reconnect failed', e); }

    if (result === 'denied') {
      // permission was turned off in iOS Settings since load → point there instead
      removeReconnect();
      _dismissed = false;
      renderNudgeBanner('denied');
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Reconnect notifications'; }
    if (msg) {
      msg.textContent = result === 'on'
        ? "Reconnected — you're set to receive notifications."
        : 'Could not reconnect — try again in a moment.';
    }
  }

  function escapeHtml(s) {
    return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // CHANGE 1 (2d): silent self-heal on every board open. If permission is
  // granted, make sure there's an active push subscription (re-subscribe if
  // iOS silently dropped it) and ALWAYS re-upsert it to push_subscriptions
  // (Cris's option 1 — no check-then-write). endpoint is the PK, so re-writing
  // the same device just refreshes the row + last_seen_at with no duplicates,
  // and restores a row that ever went missing (the silent-save failure we hit).
  // Invisible, best-effort — wrapped so it can NEVER block board load or throw.
  async function selfHeal() {
    try {
      if (!pushSupported()) return;
      if (Notification.permission !== 'granted') return;   // not granted → the nudge banner covers it
      var reg = await navigator.serviceWorker.getRegistration('/') || await navigator.serviceWorker.ready;
      if (!reg) return;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // granted but no active subscription (iOS can drop it) → re-subscribe
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
        });
      }
      await upsertSubscription(sub);   // ALWAYS re-upsert
      renderPushUI();                  // reflect true state (e.g. off→on if we just re-subscribed)
    } catch (e) {
      console.warn('[Push] self-heal skipped', e && e.message);   // swallow — never blocks load
    }
  }

  // ── entry point ──
  async function initPush(config) {
    config = config || {};
    _db = config.db || null;
    if (typeof config.getIdentity === 'function') _getIdentity = config.getIdentity;
    await renderPushUI();
    selfHeal();   // fire-and-forget background heal — never awaited, never blocks load
  }

  global.CrisPush = {
    initPush: initPush,
    pushSupported: pushSupported,
    isInstalledStandalone: isInstalledStandalone,
    getPushState: getPushState,
    enablePush: enablePush,
    disablePush: disablePush,
    selfHeal: selfHeal,
  };
})(window);
