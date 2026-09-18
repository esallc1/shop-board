/* ============================================================
   new-badge.js — the reusable "NEW" pill for freshly shipped features.

   USE (any board):
     <link rel="stylesheet" href="shared/new-badge.css">
     <script type="module">
       import * as NewBadge from './shared/new-badge.js';
       window.NewBadge = NewBadge;
       NewBadge.startNewBadges(document);
     </script>
     …then, next to the new thing:
     <span class="cd-new" data-new-until="2026-09-26">NEW</span>

   THE RULE: the badge shows while TODAY — in shop time, America/New_York —
   is strictly BEFORE `data-new-until`, and hides on/after that date. So
   until="2026-09-26" shows through the end of Friday Sept 25 (ET).

   FAIL-SAFE HIDDEN. The CSS hides every .cd-new by default; this module only
   ever turns one ON (adds .is-on). A missing, malformed or impossible date is
   never visible, and if this script fails to load, nothing shows at all —
   the badge can never get stuck on forever. No DB, no settings: the date
   lives in the markup and the expiry is a code change nobody has to make.

   Pure date logic (`shopToday`, `parseUntil`, `isNewBadgeVisible`) has no DOM
   and is imported directly by shared/new-badge.test.js under `node --test`.
   ============================================================ */

export const SHOP_TIME_ZONE = 'America/New_York';

// Today's date in shop time as 'YYYY-MM-DD'. NOT the UTC date: at 9pm ET it
// is already tomorrow in UTC, and a badge must not vanish three hours early.
export function shopToday(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// 'YYYY-MM-DD' that names a real calendar day → that string; anything else →
// null. Rejects '2026-02-30', '2026-9-26', '9/26/2026', '', null, garbage.
export function parseUntil(value) {
  const s = String(value == null ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

// THE DECISION. Visible only when the date is valid AND shop-today < until.
// ISO dates compare correctly as strings.
export function isNewBadgeVisible(until, now) {
  const u = parseUntil(until);
  if (!u) return false;
  const today = shopToday(now);
  return !!today && today < u;
}

// ── browser side ─────────────────────────────────────────────
// Turn each .cd-new under `root` on or off for `now`. Idempotent; safe to
// re-run. Only ever toggles the .is-on class — never touches layout.
export function applyNewBadges(root, now) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || !scope.querySelectorAll) return 0;
  let shown = 0;
  scope.querySelectorAll('.cd-new').forEach((el) => {
    const on = isNewBadgeVisible(el.getAttribute('data-new-until'), now);
    el.classList.toggle('is-on', on);
    if (on) shown++;
  });
  return shown;
}

// Apply now, then keep it honest on a page that stays open for days (the
// counter iPad never reloads): re-check hourly and whenever the tab comes
// back, and pick up badges that arrive in markup rendered later.
let started = false;
export function startNewBadges(root) {
  if (typeof document === 'undefined') return;
  const scope = root || document;
  applyNewBadges(scope);
  if (started) return;
  started = true;
  setInterval(() => applyNewBadges(scope), 60 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applyNewBadges(scope);
  });
  if (typeof MutationObserver !== 'undefined' && document.body) {
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('.cd-new')) applyNewBadges(n.parentNode || scope);
          else if (n.querySelector && n.querySelector('.cd-new')) applyNewBadges(n);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
}
