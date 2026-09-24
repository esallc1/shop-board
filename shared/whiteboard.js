/* ============================================================
   whiteboard.js — the "📋 Whiteboard" panel of the advisor board's bottom
   drawer (shared/bottom-drawer.js owns the tab, push-up, height, Hide, Esc).
   Wiring: docs/wiring/whiteboard.md. Rules: shared/whiteboard-logic.js.

   The shop's shared whiteboard — what the Desk tab doesn't hold. DRAWN like
   the real board on the office wall (the approved Front Desk mockup, Cris
   2026-09-16/24): aluminum frame, glossy white board, "FRONT OFFICE" in marker
   with today's date in red, zone titles in coloured marker, lines in
   handwriting with ⚡ auto / ✎ hand chips, a marker tray along the bottom.
   Fonts are self-hosted (shared/fonts) — no font CDN. Three zones:
     1. WAITING ON PARTS (red)       — "coming next" in faint marker (slice 5).
     2. READY → CALL FOR PICKUP (blue, automatic): every RO with status 'invoice'.
        Click a line → the RO opens the normal way (RO Board tab + cdOpenRo).
     3. DON'T FORGET (red)           — "coming next" in faint marker (slice 4).

   READ-ONLY (slice 2). ONE query — `READY_SELECT` where status = 'invoice' —
   with the board's own signed-in Supabase client. This file never writes
   (test-locked: no .update( / .insert( / .upsert( / .delete( / .rpc(), and it
   never goes through the RO detail's open/current-RO code for the list, so
   drawing the board can't re-save an RO (the book_hours trap).

   LIVE: a realtime channel on repair_orders (any change → one debounced
   re-read), a catch-up re-read every minute, and one when the tab comes back.
   ============================================================ */
import { isBoardToggleKey } from './desk-pad-logic.js';
import { READY_STATUS, READY_SELECT, readyLines, boardDate } from './whiteboard-logic.js';

const CATCH_UP_MS = 60 * 1000;
const DEBOUNCE_MS = 400;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Panel factory for mountBottomDrawer. `db` = the board's Supabase client.
export function createWhiteboardPanel(ctx, { db } = {}) {
  let lines = [];
  let loaded = false;
  let failed = false;

  const el = document.createElement('div');
  el.className = 'wb';
  el.innerHTML = `
      <div class="wb-body"><div class="wb-frame">
        <div class="wb-board">
          <div class="wb-title"><b>FRONT OFFICE</b><span data-wb="date"></span></div>
          <div class="wb-grid">
            <section class="wz red" aria-labelledby="wbPartsH">
              <h4 id="wbPartsH">WAITING ON PARTS</h4>
              <p class="wz-soon">coming next</p>
            </section>
            <section class="wz blue wz-wide" aria-labelledby="wbReadyH">
              <h4 id="wbReadyH">READY → CALL FOR PICKUP</h4>
              <ul class="wz-list" data-wb="ready"></ul>
            </section>
            <section class="wz red" aria-labelledby="wbNotesH">
              <h4 id="wbNotesH">DON'T FORGET</h4>
              <p class="wz-soon">coming next</p>
            </section>
          </div>
        </div>
        <div class="wb-tray" aria-hidden="true"><i></i><i></i><i></i></div>
      </div></div>`;
  const scroller = el.querySelector('.wb-body');
  const frame = el.querySelector('.wb-frame');
  const list = el.querySelector('[data-wb="ready"]');
  const dateEl = el.querySelector('[data-wb="date"]');
  const AUTO = '<span class="wb-chip auto" title="Fills itself from the RO Board">⚡ auto</span>';

  function draw() {
    dateEl.textContent = boardDate();
    let html = lines.map((l) => {
      const ro = l.po && l.roNumber && l.po !== l.roNumber ? ` <small>RO ${esc(l.roNumber)}</small>` : '';
      return `<li>${AUTO}<button type="button" class="wz-line" data-wb-ro="${esc(l.id)}" title="Open RO ${esc(l.number)}">` +
        `${esc(l.number)}${ro} ${esc(l.customer)}${l.vehicle ? ` — ${esc(l.vehicle)}` : ''}</button></li>`;
    }).join('');
    if (!lines.length) html = `<li class="wz-empty">${loaded ? 'nobody waiting on a call' : (failed ? '' : '…')}</li>`;
    if (failed) html += `<li class="wz-err">couldn't load the list — trying again</li>`;
    list.innerHTML = html;
    ctx.recount();
    ctx.refit();
  }

  let busy = false, again = false;
  async function load() {
    if (!db) { failed = true; draw(); return; }
    if (busy) { again = true; return; }
    busy = true;
    try {
      const { data, error } = await db.from('repair_orders').select(READY_SELECT)
        .eq('status', READY_STATUS).order('created_at', { ascending: true });
      if (error) throw error;
      lines = readyLines(data);
      loaded = true; failed = false;
    } catch (e) {
      console.warn('[Whiteboard] ready list', e);
      failed = true;          // keep the last good lines on screen
    } finally {
      busy = false;
      draw();
      if (again) { again = false; load(); }
    }
  }

  let debounce = null;
  function schedule() { clearTimeout(debounce); debounce = setTimeout(load, DEBOUNCE_MS); }

  // Click a line → the RO opens the normal way (same path as global search).
  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-wb-ro]');
    if (!b || !window.cdOpenRo) return;
    const nav = document.querySelector('.sidebar-item[data-view="cdros"]'); if (nav) nav.click();
    window.cdOpenRo(b.dataset.wbRo);
  });

  if (db) {
    try {
      db.channel('advisor-board-whiteboard-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'repair_orders' }, schedule)
        .subscribe((status) => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('[Whiteboard] realtime', status); });
    } catch (e) { console.warn('[Whiteboard] realtime', e); }
  }
  setInterval(load, CATCH_UP_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(); });

  draw();
  load();

  return {
    id: 'board', label: 'Whiteboard', icon: '📋', key: 'W',
    subtitle: 'Shared · everyone in the office sees this',
    isKey: isBoardToggleKey,
    el, actions: null,
    observe: [frame],
    count: () => lines.length,
    measure() {
      const cs = getComputedStyle(scroller);
      return { chrome: 0, content: frame.offsetHeight + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) };
    },
    onShow() { schedule(); return false; },
  };
}
