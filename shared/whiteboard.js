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
     1. WAITING ON PARTS (red)  — "coming next" in faint marker (slice 5).
     2. READY → CALL FOR PICKUP (blue, automatic): every RO with status
        'invoice'. Click a line → the RO opens the normal way (RO Board tab +
        cdOpenRo). "Called ✓" stamps who + when; a small "undo" clears a
        mis-tap. The stamp stays with the RO, so if it comes back to 'invoice'
        later the old stamp shows again.
     3. DON'T FORGET (red, by hand): "+ write on board", who + when on every
        line, anyone can erase any line, "Recently erased" (7 days) with Undo.

   READS — with the board's own signed-in Supabase client: repair_orders
   (READY_SELECT, status 'invoice'), whiteboard_pickup_calls and
   whiteboard_items (staff only, RLS is_staff()). WRITES — NEVER through the
   client: every change is a POST to /api/whiteboard via cdAuthFetch, which
   checks the employee and stamps who + when on the server. This file never
   calls .update( / .insert( / .upsert( / .delete( / .rpc( and never touches
   the RO detail's open/current-RO code, so it can't re-save an RO
   (the book_hours trap). Test-locked.

   LIVE: one realtime channel on repair_orders + both whiteboard tables (after
   db.realtime.setAuth(token), like the Messenger tray — the whiteboard tables
   are staff-only, so the socket must run as the viewer), any change → one
   debounced re-read; a catch-up re-read every minute, and one when the tab
   comes back or the Whiteboard is shown.
   ============================================================ */
import { isBoardToggleKey } from './desk-pad-logic.js';
import {
  READY_STATUS, READY_SELECT, readyLines, boardDate,
  CALL_SELECT, ITEM_SELECT, RECENT_DAYS, NOTE_MAX, callsByRo, noteLists, stamp, upsertRow, actionError,
} from './whiteboard-logic.js';

const API = '/api/whiteboard';
const CATCH_UP_MS = 60 * 1000;
const DEBOUNCE_MS = 400;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Panel factory for mountBottomDrawer. `db` = the board's Supabase client.
export function createWhiteboardPanel(ctx, { db } = {}) {
  let lines = [];            // Ready → call for pickup
  let calls = [];            // whiteboard_pickup_calls rows for those ROs
  let items = [];            // whiteboard_items rows (open + recently cleared)
  let loaded = false, failed = false, handOk = false;
  let showErased = false;
  const inFlight = {};       // line key → true while its request is out (buttons disabled)
  let noteErr = '', readyErr = '';

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
              <p class="wz-err" data-wb="ready-err" hidden></p>
            </section>
            <section class="wz red" aria-labelledby="wbNotesH">
              <h4 id="wbNotesH">DON'T FORGET</h4>
              <ul class="wz-list" data-wb="notes"></ul>
              <form class="wz-form" data-wb="form" hidden>
                <input class="wz-input" data-wb="input" type="text" maxlength="${NOTE_MAX}" autocomplete="off"
                  placeholder="write it on the board…" aria-label="Write on the board">
                <button type="submit" class="wz-link">save</button>
                <button type="button" class="wz-link" data-wb-act="cancel">cancel</button>
              </form>
              <p class="wz-err" data-wb="note-err" hidden></p>
              <div class="wz-foot">
                <button type="button" class="wz-link" data-wb-act="write" hidden>+ write on board</button>
                <button type="button" class="wz-link" data-wb-act="erased" hidden></button>
              </div>
              <ul class="wz-list wz-erased" data-wb="erased" hidden></ul>
            </section>
          </div>
        </div>
        <div class="wb-tray" aria-hidden="true"><i></i><i></i><i></i></div>
      </div></div>`;
  const $ = (k) => el.querySelector(`[data-wb="${k}"]`);
  const scroller = el.querySelector('.wb-body');
  const frame = el.querySelector('.wb-frame');
  const readyList = $('ready'), notesList = $('notes'), erasedList = $('erased');
  const form = $('form'), input = $('input'), dateEl = $('date');
  const writeBtn = el.querySelector('[data-wb-act="write"]');
  const erasedBtn = el.querySelector('[data-wb-act="erased"]');
  const AUTO = '<span class="wb-chip auto" title="Fills itself from the RO Board">⚡ auto</span>';
  const HAND = '<span class="wb-chip hand" title="Written by hand">✎ hand</span>';

  /* ── drawing ─────────────────────────────────────────────────────────── */
  function drawReady() {
    const byRo = callsByRo(calls);
    let html = lines.map((l) => {
      const ro = l.po && l.roNumber && l.po !== l.roNumber ? ` <small>RO ${esc(l.roNumber)}</small>` : '';
      const c = byRo.get(l.id);
      const off = inFlight['ro:' + l.id] ? ' disabled' : '';
      const mark = !handOk ? '' : c
        ? `<span class="wz-called" title="Called for pickup">✓ called · ${esc(stamp(c.called_by_name, c.called_at))}</span>` +
          `<button type="button" class="wz-link wz-undo" data-wb-act="uncall" data-ro="${esc(l.id)}"${off} title="Undo — not called yet">undo</button>`
        : `<button type="button" class="wz-callbtn" data-wb-act="call" data-ro="${esc(l.id)}"${off} title="Mark: customer called for pickup">Called ✓</button>`;
      return `<li class="${c ? 'is-called' : ''}">${AUTO}<span class="wz-text">` +
        `<button type="button" class="wz-line" data-wb-ro="${esc(l.id)}" title="Open RO ${esc(l.number)}">` +
        `${esc(l.number)}${ro} ${esc(l.customer)}${l.vehicle ? ` — ${esc(l.vehicle)}` : ''}</button> ${mark}</span></li>`;
    }).join('');
    if (!lines.length) html = `<li class="wz-empty">${loaded ? 'nobody waiting on a call' : (failed ? '' : '…')}</li>`;
    if (failed) html += `<li class="wz-err">couldn't load the list — trying again</li>`;
    readyList.innerHTML = html;
    const re = $('ready-err'); re.textContent = readyErr; re.hidden = !readyErr;
  }

  function drawNotes() {
    const { open, erased } = noteLists(items);
    notesList.innerHTML = open.map((n) => {
      const off = inFlight[n.id] ? ' disabled' : '';
      return `<li>${HAND}<span class="wz-text">${esc(n.text)} <small class="wz-who">— ${esc(stamp(n.created_by_name, n.created_at))}</small>` +
        `<button type="button" class="wz-x" data-wb-act="erase" data-id="${esc(n.id)}"${off} aria-label="Erase this line" title="Erase this line">×</button></span></li>`;
    }).join('') || (handOk ? '' : `<li class="wz-empty">${loaded ? '' : '…'}</li>`);
    writeBtn.hidden = !handOk || !form.hidden;
    erasedBtn.hidden = !handOk || !erased.length;
    erasedBtn.textContent = `recently erased (${erased.length}) ${showErased ? '▴' : '▾'}`;
    erasedBtn.setAttribute('aria-expanded', String(showErased));
    erasedList.hidden = !showErased || !erased.length;
    erasedList.innerHTML = erased.map((n) => {
      const off = inFlight[n.id] ? ' disabled' : '';
      return `<li><span class="wz-text"><s>${esc(n.text)}</s> <small class="wz-who">erased by ${esc(stamp(n.cleared_by_name, n.cleared_at))}</small>` +
        `<button type="button" class="wz-link" data-wb-act="undo" data-id="${esc(n.id)}"${off}>Undo</button></span></li>`;
    }).join('');
    const ne = $('note-err'); ne.textContent = noteErr; ne.hidden = !noteErr;
  }

  function draw() {
    dateEl.textContent = boardDate();
    drawReady();
    drawNotes();
    ctx.recount();
    ctx.refit();
  }

  /* ── reading ─────────────────────────────────────────────────────────── */
  let channel = null;
  function subscribe(token) {
    if (channel || !db) return;
    try { if (token && db.realtime && db.realtime.setAuth) db.realtime.setAuth(token); } catch (e) {}
    try {
      channel = db.channel('advisor-board-whiteboard-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'repair_orders' }, schedule)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'whiteboard_items' }, schedule)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'whiteboard_pickup_calls' }, schedule)
        .subscribe((status) => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('[Whiteboard] realtime', status); });
    } catch (e) { console.warn('[Whiteboard] realtime', e); }
  }

  let loading = false, again = false;
  async function load() {
    if (!db) { failed = true; draw(); return; }
    if (loading) { again = true; return; }
    loading = true;
    try {
      let token = null;
      try { const s = await db.auth.getSession(); token = s && s.data && s.data.session && s.data.session.access_token; } catch (e) {}
      subscribe(token);

      const { data, error } = await db.from('repair_orders').select(READY_SELECT)
        .eq('status', READY_STATUS).order('created_at', { ascending: true });
      if (error) throw error;
      lines = readyLines(data);
      loaded = true; failed = false;

      // The hand-written half needs a signed-in staff session (RLS is_staff()).
      if (token) {
        const since = new Date(Date.now() - RECENT_DAYS * 24 * 3600e3).toISOString();
        const [c, it] = await Promise.all([
          lines.length
            ? db.from('whiteboard_pickup_calls').select(CALL_SELECT).in('ro_id', lines.map((l) => l.id))
            : Promise.resolve({ data: [], error: null }),
          db.from('whiteboard_items').select(ITEM_SELECT).eq('kind', 'note')
            .or(`cleared_at.is.null,cleared_at.gte.${since}`).order('created_at', { ascending: true }).limit(300),
        ]);
        if (c.error) throw c.error;
        if (it.error) throw it.error;
        calls = c.data || [];
        items = it.data || [];
        handOk = true;
      } else {
        handOk = false;
      }
    } catch (e) {
      console.warn('[Whiteboard] load', e);
      failed = true;          // keep the last good lines on screen
    } finally {
      loading = false;
      draw();
      if (again) { again = false; load(); }
    }
  }

  let debounce = null;
  function schedule() { clearTimeout(debounce); debounce = setTimeout(load, DEBOUNCE_MS); }

  /* ── writing — only through /api/whiteboard ──────────────────────────── */
  async function post(payload) {
    if (typeof window.cdAuthFetch !== 'function') return { status: 0, body: { message: 'This board is missing its sign-in helper — reload the page.' } };
    try {
      const r = await window.cdAuthFetch(db, API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      let body = null;
      try { body = await r.json(); } catch (e) {}
      return { status: r.status, ok: r.ok, body };
    } catch (e) {
      return { status: 0, body: null };
    }
  }

  // Send one action; on success fold the returned row in at once (our own
  // screen doesn't wait for realtime), then a quick re-read to be sure.
  async function act(key, payload, onOk, setErr) {
    inFlight[key] = true; setErr(''); draw();
    const r = await post(payload);
    delete inFlight[key];
    if (r.ok) onOk(r.body || {}); else setErr(actionError(r.status, r.body));
    draw();
    schedule();
    return r.ok;
  }
  const setNoteErr = (t) => { noteErr = t; };
  const setReadyErr = (t) => { readyErr = t; };

  function openForm() { form.hidden = false; noteErr = ''; draw(); input.focus(); }
  function closeForm() { form.hidden = true; input.value = ''; draw(); }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) { closeForm(); return; }
    input.disabled = true;
    const ok = await act('new', { action: 'add', kind: 'note', text },
      (b) => { if (b.item) items = upsertRow(items, b.item); }, setNoteErr);
    input.disabled = false;
    // Saved → the box closes (Cris, 2026-09-24); "+ write on board" opens it again.
    // Not saved → it stays open with the text, so nothing typed is lost.
    if (ok) { closeForm(); writeBtn.focus(); } else input.focus();
  });
  // Esc in the box closes the box only — not the whole drawer (the drawer skips a prevented Esc).
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeForm(); writeBtn.focus(); }
  });

  el.addEventListener('click', (ev) => {
    const lineBtn = ev.target.closest('[data-wb-ro]');
    if (lineBtn) {
      // Click a Ready line → the RO opens the normal way (same path as global search).
      if (!window.cdOpenRo) return;
      const nav = document.querySelector('.sidebar-item[data-view="cdros"]'); if (nav) nav.click();
      window.cdOpenRo(lineBtn.dataset.wbRo);
      return;
    }
    const b = ev.target.closest('[data-wb-act]');
    if (!b || b.disabled) return;
    const id = b.dataset.id, ro = b.dataset.ro;
    switch (b.dataset.wbAct) {
      case 'write': openForm(); return;
      case 'cancel': closeForm(); return;
      case 'erased': showErased = !showErased; draw(); return;
      case 'erase':
        act(id, { action: 'clear', id, reason: 'erased' }, (r) => { if (r.item) items = upsertRow(items, r.item); }, setNoteErr);
        return;
      case 'undo':
        act(id, { action: 'undo', id }, (r) => { if (r.item) items = upsertRow(items, r.item); }, setNoteErr);
        return;
      case 'call':
        act('ro:' + ro, { action: 'called', ro_id: ro }, (r) => { if (r.call) calls = upsertRow(calls, r.call, 'ro_id'); }, setReadyErr);
        return;
      case 'uncall':
        act('ro:' + ro, { action: 'uncalled', ro_id: ro }, (r) => { if (r.call) calls = upsertRow(calls, r.call, 'ro_id'); }, setReadyErr);
        return;
      default: return;
    }
  });

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
