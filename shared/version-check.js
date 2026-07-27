/* ============================================================
   version-check.js — in-app update PROMPT for installed PWAs.

   Why: iOS standalone PWAs keep a launched page (and its already-loaded JS)
   in memory across background/foreground, so a new deploy only lands on a
   fresh navigation (force-quit + relaunch). Nothing else pulls new code into
   a running board. This module notices a new deploy and OFFERS a refresh.

   It NEVER auto-reloads — the boards hold unsaved input (chat drafts, RO
   edits, planner capture) and reloading mid-edit is worse than being one
   version behind. So: a small dismissible banner, user taps to refresh.

   How: on load, record the currently-deployed commit SHA (/api/version) as
   this page's baseline. On visibility -> visible (the same foreground signal
   the boards' refresh safety net uses — NOT a polling timer), re-fetch and
   compare. Changed -> show "New version - tap to refresh" -> location.reload().

   Fails SILENTLY: any fetch/parse error, or a missing SHA (e.g. local/dev
   where /api/version doesn't exist), does nothing — no banner, no console
   noise, no blocked UI. A broken update check must never degrade the board.

   One-line include, self-initialising (like pwa-register.js):
     <script src="/shared/version-check.js"></script>
   ============================================================ */
(function () {
  if (window.__versionCheckInit) return;   // idempotent — safe to include twice
  window.__versionCheckInit = true;

  var ENDPOINT = '/api/version';
  var loaded = null;      // baseline SHA this page is running (null => checks stay inert)
  var dismissed = null;   // SHA the user dismissed the banner for
  var banner = null;
  var busy = false;

  function fetchVersion() {
    return fetch(ENDPOINT, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.version ? String(d.version) : null; })
      .catch(function () { return null; });          // silent on any failure
  }

  function injectStyles() {
    if (document.getElementById('vc-style')) return;
    var s = document.createElement('style');
    s.id = 'vc-style';
    s.textContent = [
      '.vc-banner{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;',
      'display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);box-sizing:border-box;',
      'background:#5b5ef4;color:#fff;border-radius:12px;padding:11px 12px 11px 16px;',
      'box-shadow:0 10px 30px rgba(20,30,60,.32);',
      'font:600 14px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;}',
      '.vc-banner-msg{cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.vc-banner-x{cursor:pointer;border:none;background:rgba(255,255,255,.18);color:#fff;',
      'width:26px;height:26px;min-width:26px;border-radius:8px;padding:0;',
      'font:700 15px/1 system-ui,-apple-system,sans-serif;flex:0 0 auto;}',
      '.vc-banner-x:hover{background:rgba(255,255,255,.30);}'
    ].join('');
    document.head.appendChild(s);
  }

  function showBanner(newVersion) {
    if (banner || !document.body) return;
    injectStyles();
    banner = document.createElement('div');
    banner.className = 'vc-banner';
    var msg = document.createElement('span');
    msg.className = 'vc-banner-msg';
    msg.textContent = 'New version — tap to refresh';
    msg.addEventListener('click', function () { location.reload(); });
    var x = document.createElement('button');
    x.className = 'vc-banner-x';
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.addEventListener('click', function (e) {
      e.stopPropagation();
      dismissed = newVersion;                        // don't nag again for THIS version
      hideBanner();
    });
    banner.appendChild(msg);
    banner.appendChild(x);
    document.body.appendChild(banner);
  }
  function hideBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function check() {
    if (busy || !loaded) return;                     // no baseline => inert
    busy = true;
    fetchVersion().then(function (v) {
      busy = false;
      if (!v) return;                                // unreachable/error => silent
      if (v === loaded) { hideBanner(); return; }    // same (or rolled back) => clear any stale banner
      if (v !== dismissed) showBanner(v);            // changed & not already dismissed => prompt
    }, function () { busy = false; });
  }

  function start() {
    fetchVersion().then(function (v) { loaded = v; });   // establish baseline
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') check();
    });
  }

  if (document.readyState === 'loading') window.addEventListener('load', start);
  else start();
})();
