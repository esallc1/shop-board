/* ============================================================
   pwa-register.js — registers the CrisData service worker once per page.

   Included in every CrisData page's <head>. Guarded so it's a no-op on
   browsers without service-worker support, and registers AFTER load so it
   never competes with the page's own boot. Slice 2a: install only — the
   worker at /sw.js does no caching and no push (see sw.js).
   ============================================================ */
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (err) {
      console.warn('[PWA] service worker registration failed', err);
    });
  });
})();
