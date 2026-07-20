/* ============================================================
   CrisData service worker — Sub-slice 2a: INSTALLABLE PWA ONLY.

   Deliberately minimal and safe:
   • NO fetch caching. The fetch handler is pass-through — it never calls
     event.respondWith, so every request (including board HTML navigations)
     goes straight to the network exactly as if no service worker existed.
     This app is realtime and must NEVER be pinned to a stale HTML bundle,
     so there is intentionally no offline/precache logic here.
   • NO push handler yet (added in a later sub-slice).

   Lives at the site root so its scope covers "/", i.e. every board.
   ============================================================ */

// Take control ASAP so the single worker governs all pages on the next load.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through: presence of a fetch handler keeps the app installable, but we
// never intercept the response — the browser handles every request over the
// network as normal. Do NOT add caching here without making it network-first
// with immediate update (see the stale-bundle caution in the build notes).
self.addEventListener('fetch', () => {
  // no event.respondWith(...) → default network handling
});
