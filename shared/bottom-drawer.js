/* ============================================================
   bottom-drawer.js — the advisor board's bottom drawer (Front Desk redesign).
   Wiring: docs/wiring/desk-pad.md (§2 the drawer) · docs/wiring/whiteboard.md.

   ONE drawer at the bottom of the work area, on EVERY advisor tab (mounted
   once on <body>, outside the views — like the Messenger tray), with TABS:
   today "📝 Desk pad" (N) and "📋 Whiteboard" (W). Each tab is a PANEL built
   by its own module; this file is only the frame around them:

   - Closed: one small tab per panel at the bottom middle of the work area.
   - Click a tab / press its key → the drawer opens on that panel. Only one
     panel shows at a time; the other tab switches; the open one (or Esc with
     focus inside the drawer, or "Hide ▾") hides the drawer.
   - Open, ≥ 900 px wide: it PUSHES the page up — .main-area gets bottom padding
     the drawer's height (--bdr-h) and the window scrolls up by the same amount;
     Hide scrolls back down. Below 900 px it overlays (no push).
   - HEIGHT (Cris, 2026-09-23, from the Desk pad): the header plus the shown
     panel's content, at least one row, capped at 45 % of the window (then the
     panel scrolls inside). `padHeight` decides; the push follows the real
     height, so switching panels or adding notes moves the page by the change.
   - Right edge: the window, or the Facebook tray's left edge while it's open.

   A PANEL is { id, label, icon, subtitle, isKey(ev, activeEl), el, actions,
   measure() → { chrome, content }, observe: [elements to watch for size],
   count() → number, onShow?(how), onHide?() }, made by a factory that gets
   `ctx` = { refit(), recount(), show(id), hide(), isShown(id) }.

   This file takes no Supabase client and makes no network call (test-locked):
   a panel that needs the database (the Whiteboard) brings its own.
   ============================================================ */
import { padHeight, pushScrollTarget } from './desk-pad-logic.js';

const PUSH_MIN_WIDTH = 900;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function mountBottomDrawer({ panels: factories = [] } = {}) {
  if (document.getElementById('bdrawer')) return null;

  let shown = null;        // id of the panel on screen, or null when hidden
  let pushedBy = 0;        // px the window has been scrolled by the drawer (to undo on hide)
  let shownH = 0;          // the drawer's height as last applied

  const root = document.createElement('div');
  root.id = 'bdrawer';
  root.className = 'bdr';
  root.innerHTML = `
    <div class="bdr-tabs" role="group" aria-label="Bottom drawer"></div>
    <section class="bdr-sheet" id="bdrSheet" hidden>
      <div class="bdr-top">
        <div class="bdr-switch" role="tablist" aria-label="Drawer"></div>
        <small class="bdr-sub"></small>
        <div class="bdr-actions"></div>
        <button type="button" class="dpad-btn is-ghost bdr-hide" data-bdr="hide">Hide ▾</button>
      </div>
      <div class="bdr-host"></div>
    </section>`;
  document.body.appendChild(root);
  const closedTabs = root.querySelector('.bdr-tabs');
  const sheet = root.querySelector('.bdr-sheet');
  const top = root.querySelector('.bdr-top');
  const sw = root.querySelector('.bdr-switch');
  const sub = root.querySelector('.bdr-sub');
  const actionsHost = root.querySelector('.bdr-actions');
  const host = root.querySelector('.bdr-host');

  const ctx = {
    refit: () => fitHeight(),
    recount: () => drawCounts(),
    show: (id, how) => show(id, how),
    hide: () => show(null),
    isShown: (id) => shown === id,
  };
  // Assigned after the factories return (a factory may call ctx.recount/refit
  // while it builds — both are no-ops until then).
  let panels = [];
  let byId = new Map();
  panels = factories.map((f) => f(ctx)).filter(Boolean);
  byId = new Map(panels.map((p) => [p.id, p]));

  for (const p of panels) {
    const kbd = p.key ? `<span class="dpad-kbd" aria-hidden="true">${esc(p.key)}</span>` : '';
    closedTabs.insertAdjacentHTML('beforeend',
      `<button type="button" class="bdr-tab" data-bdr="tab" data-panel="${esc(p.id)}" aria-controls="bdrSheet" aria-expanded="false" title="${esc(p.label)}${p.key ? ` (${esc(p.key)})` : ''}">` +
      `${esc(p.icon)} ${esc(p.label)} <span class="dpad-count" data-count="${esc(p.id)}"></span>${kbd}</button>`);
    sw.insertAdjacentHTML('beforeend',
      `<button type="button" class="bdr-sw" role="tab" data-bdr="tab" data-panel="${esc(p.id)}" aria-selected="false" title="${esc(p.label)}${p.key ? ` (${esc(p.key)})` : ''}">` +
      `${esc(p.icon)} ${esc(p.label)} <span class="dpad-count" data-count="${esc(p.id)}"></span></button>`);
    p.el.hidden = true;
    host.appendChild(p.el);
    if (p.actions) { p.actions.hidden = true; actionsHost.appendChild(p.actions); }
  }

  function drawCounts() {
    for (const p of panels) {
      const n = Number(p.count ? p.count() : 0) || 0;
      root.querySelectorAll(`[data-count="${CSS.escape(p.id)}"]`).forEach((c) => {
        c.textContent = n ? String(n) : '';
        c.hidden = !n;
      });
    }
  }

  const pushes = () => window.innerWidth >= PUSH_MIN_WIDTH;

  // Size the drawer to the shown panel (padHeight), then move the page by the
  // change so the push always equals the drawer's real height.
  function fitHeight() {
    const p = shown && byId.get(shown);
    if (!p) return;
    const m = p.measure();
    const chrome = top.offsetHeight + (m.chrome || 0) + (parseFloat(getComputedStyle(sheet).borderTopWidth) || 0);
    const h = padHeight(chrome, m.content, window.innerHeight);
    if (h === shownH) return;
    // Read the scroll BEFORE the padding changes: shrinking the padding can make the
    // browser pull the page back on its own, and the undo-amount must count that too.
    const before = window.scrollY;
    sheet.style.height = h + 'px';
    document.documentElement.style.setProperty('--bdr-h', h + 'px');
    if (pushes()) {
      window.scrollTo(0, pushScrollTarget(before, shownH, h));
      pushedBy += window.scrollY - before;
    }
    shownH = h;
  }

  // Show panel `id` (switching if another is up), or hide the drawer (id null).
  // `how` is passed to the panel: 'key' | 'click' | 'api'.
  function show(id, how = 'api') {
    const next = id && byId.has(id) ? id : null;
    if (next === shown) return;
    const prev = shown && byId.get(shown);
    if (prev) { prev.el.hidden = true; if (prev.actions) prev.actions.hidden = true; if (prev.onHide) prev.onHide(); }
    shown = next;
    root.querySelectorAll('[data-bdr="tab"]').forEach((b) => {
      const on = b.dataset.panel === shown;
      if (b.classList.contains('bdr-sw')) { b.setAttribute('aria-selected', String(on)); b.classList.toggle('is-on', on); }
      else b.setAttribute('aria-expanded', String(on));
    });
    if (!shown) {
      if (pushedBy) window.scrollBy(0, -pushedBy);
      pushedBy = 0; shownH = 0;
      sheet.hidden = true;
      sheet.style.height = '';
      document.body.classList.remove('bdr-open');
      document.documentElement.style.removeProperty('--bdr-h');
      return;
    }
    const p = byId.get(shown);
    sheet.setAttribute('aria-label', p.label);
    sub.textContent = p.subtitle || '';
    p.el.hidden = false;
    if (p.actions) p.actions.hidden = false;
    if (!prev) {
      sheet.hidden = false;
      document.body.classList.add('bdr-open');
      shownH = 0; pushedBy = 0;
    }
    fitHeight();
    // Focus lands inside the drawer so Esc works: the panel may take it (the pad
    // focuses its first note on N), else its switcher tab.
    const took = p.onShow ? p.onShow(how) : false;
    if (!took) { const b = sw.querySelector(`[data-panel="${CSS.escape(shown)}"]`); if (b) b.focus(); }
  }

  // The tab you're on hides the drawer; the other one switches to it.
  function toggle(id, how) { show(shown === id ? null : id, how); }

  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-bdr]');
    if (!b) return;
    if (b.dataset.bdr === 'hide') {
      const was = shown; show(null);
      const t = closedTabs.querySelector(`[data-panel="${CSS.escape(was || '')}"]`); if (t) t.focus();
      return;
    }
    if (b.dataset.bdr === 'tab') toggle(b.dataset.panel, 'click');
  });

  document.addEventListener('keydown', (ev) => {
    // A field inside a panel that uses Esc itself (e.g. the Whiteboard's write box) prevents default.
    if (ev.key === 'Escape' && !ev.defaultPrevented && shown && root.contains(document.activeElement)) {
      ev.preventDefault();
      const was = shown; show(null);
      const t = closedTabs.querySelector(`[data-panel="${CSS.escape(was)}"]`); if (t) t.focus();
      return;
    }
    const p = panels.find((x) => x.isKey && x.isKey(ev, document.activeElement));
    if (p) { ev.preventDefault(); toggle(p.id, 'key'); }
  });

  // Content wrapping to a new row / a row emptying → refit (the push follows).
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => fitHeight());
    panels.forEach((p) => (p.observe || []).forEach((el) => ro.observe(el)));
  }

  // Window resize: refit (the cap is a share of the window height); crossing below
  // 900px undoes the push (overlay there).
  window.addEventListener('resize', () => {
    if (!shown) return;
    if (!pushes() && pushedBy) { window.scrollBy(0, -pushedBy); pushedBy = 0; }
    fitHeight();
  });

  drawCounts();
  return { show: (id) => show(id), hide: () => show(null), shown: () => shown };
}
