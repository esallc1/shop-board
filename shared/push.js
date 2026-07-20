/* ============================================================
   push.js — Web Push permission + subscription capture (sub-slice 2b).

   NO sending here (that's 2c). This module:
   • detects push support / iOS-install state,
   • on a user gesture, requests Notification permission and subscribes via
     PushManager using the VAPID PUBLIC key below,
   • UPSERTs the subscription into push_subscriptions (endpoint PK),
   • renders a persistent, light-theme "nudge until enabled" banner on the
     office boards.

   Identity (subscriber_name/role) is read LIVE via the board's getIdentity
   getter — never a snapshot — same pattern as team-chat.js. Degrades
   gracefully if push_subscriptions isn't migrated yet (PGRST205 → off).

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

  async function renderBanner() {
    if (_dismissed) { removeBanner(); return; }
    var state = await getPushState();
    removeBanner();
    if (state === 'on' || state === 'unsupported') return;   // nothing to nudge
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
        renderBanner();   // re-evaluate (on → hides; denied → shows denied; off → stays)
      });
    }
    el.querySelector('#pn-dismiss').addEventListener('click', function () {
      _dismissed = true;   // hidden this page-load; returns on reload / next session
      removeBanner();
    });
  }

  function escapeHtml(s) {
    return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── entry point ──
  async function initPush(config) {
    config = config || {};
    _db = config.db || null;
    if (typeof config.getIdentity === 'function') _getIdentity = config.getIdentity;
    await renderBanner();
  }

  global.CrisPush = {
    initPush: initPush,
    pushSupported: pushSupported,
    isInstalledStandalone: isInstalledStandalone,
    getPushState: getPushState,
    enablePush: enablePush,
    disablePush: disablePush,
  };
})(window);
