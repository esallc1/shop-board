/* ============================================================
   whiteboard.js — the "📋 Whiteboard" panel of the advisor board's bottom
   drawer (shared/bottom-drawer.js owns the tab, push-up, height, Hide, Esc).
   Wiring: docs/wiring/whiteboard.md. Rules: shared/whiteboard-logic.js.

   The shop's shared whiteboard — what the Desk tab doesn't hold. Three zones:
     1. READY → CALL FOR PICKUP (automatic): every RO with status 'invoice'.
        Click a line → the RO opens the normal way (RO Board tab + cdOpenRo).
     2. WAITING ON PARTS — "coming next" placeholder (slice 5).
     3. DON'T FORGET     — "coming next" placeholder (slice 4).

   READ-ONLY (slice 2). ONE query — `READY_SELECT` where status = 'invoice' —
   with the board's own signed-in Supabase client. This file never writes
   (test-locked: no .update( / .insert( / .upsert( / .delete( / .rpc(), and it
   never goes through the RO detail's open/current-RO code for the list, so
   drawing the board can't re-save an RO (the book_hours trap).

   LIVE: a realtime channel on repair_orders (any change → one debounced
   re-read), a catch-up re-read every minute, and one when the tab comes back.
   ============================================================ */
import { isBoardToggleKey } from './desk-pad-logic.js';
import { READY_STATUS, READY_SELECT, readyLines } from './whiteboard-logic.js';

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
      <div class="wb-body"><div class="wb-grid">
        <section class="wb-zone wb-ready" aria-labelledby="wbReadyH">
          <h3 class="wb-h" id="wbReadyH">Ready → call for pickup <span class="wb-n" data-wb="n"></span></h3>
          <div class="wb-list" data-wb="ready"></div>
        </section>
        <section class="wb-zone is-soon" aria-labelledby="wbPartsH">
          <h3 class="wb-h" id="wbPartsH">Waiting on parts</h3>
          <p class="wb-soon">Coming next</p>
        </section>
        <section class="wb-zone is-soon" aria-labelledby="wbNotesH">
          <h3 class="wb-h" id="wbNotesH">Don't forget</h3>
          <p class="wb-soon">Coming next</p>
        </section>
      </div></div>`;
  const scroller = el.querySelector('.wb-body');
  const grid = el.querySelector('.wb-grid');
  const list = el.querySelector('[data-wb="ready"]');
  const n = el.querySelector('[data-wb="n"]');

  function draw() {
    n.textContent = lines.length ? String(lines.length) : '';
    let html = lines.map((l) => {
      const sub = l.po && l.roNumber && l.po !== l.roNumber ? ` <small>RO ${esc(l.roNumber)}</small>` : '';
      return `<button type="button" class="wb-line" data-wb-ro="${esc(l.id)}" title="Open RO ${esc(l.number)}">` +
        `<b class="wb-num">${esc(l.number)}</b>${sub}` +
        `<span class="wb-cust">${esc(l.customer)}</span>` +
        (l.vehicle ? `<span class="wb-veh">${esc(l.vehicle)}</span>` : '') +
        `</button>`;
    }).join('');
    if (!lines.length) html = `<p class="wb-empty">${loaded ? 'No ROs waiting for pickup.' : (failed ? '' : 'Loading…')}</p>`;
    if (failed) html += `<p class="wb-err">Couldn't load the list — trying again shortly.</p>`;
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
    observe: [grid],
    count: () => lines.length,
    measure() {
      const cs = getComputedStyle(scroller);
      return { chrome: 0, content: grid.offsetHeight + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) };
    },
    onShow() { schedule(); return false; },
  };
}
