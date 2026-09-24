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
     1. WAITING ON PARTS (red, by hand): "+ write on board" → an optional RO
        (picked from the open ROs) + a short note. The RO part of a line opens
        the RO the normal way. "Arrived ✓" or × takes it off; both land in
        "recently cleared" (7 days) with Undo. A line whose RO is CLOSED comes
        off by itself — derived from the RO's status at read time, nothing is
        written — shown as "RO closed · <time>" without Undo (reopening the RO
        brings it back).
     2. READY → CALL FOR PICKUP (blue, automatic): every RO with status
        'invoice'. Click a line → the RO opens the normal way (RO Board tab +
        cdOpenRo). "Called ✓" stamps who + when; a small "undo" clears a
        mis-tap. The stamp stays with the RO, so if it comes back to 'invoice'
        later the old stamp shows again.
     3. DON'T FORGET (red, by hand): "+ write on board", who + when on every
        line, anyone can erase any line, "Recently erased" (7 days) with Undo.
        Also fed by the Desk pad's 📌 (slice 6): the panel's `pin(text)` posts a
        sticky's text here (the pad never touches the network — the drawer
        wires the two, shared/front-desk-drawer.js); the new line is briefly
        highlighted the next time the Whiteboard is shown.
   The write box closes after each save; Esc / cancel close it without saving.

   READS — with the board's own signed-in Supabase client: repair_orders
   (READY_SELECT, status 'invoice'; and PICK_SELECT, the open ROs, only when
   the parts box is opened), whiteboard_pickup_calls and whiteboard_items
   (staff only, RLS is_staff(); the parts line's RO comes embedded). WRITES —
   NEVER through the client: every change is a POST to /api/whiteboard via
   cdAuthFetch, which checks the employee and stamps who + when on the server.
   This file never calls .update( / .insert( / .upsert( / .delete( / .rpc( and
   never touches the RO detail's open/current-RO code, so it can't re-save an
   RO (the book_hours trap). Test-locked.

   LIVE: one realtime channel on repair_orders + both whiteboard tables (after
   db.realtime.setAuth(token), like the Messenger tray — the whiteboard tables
   are staff-only, so the socket must run as the viewer), any change → one
   debounced re-read; a catch-up re-read every minute, and one when the tab
   comes back or the Whiteboard is shown.
   ============================================================ */
import { isBoardToggleKey } from './desk-pad-logic.js';
import {
  READY_STATUS, READY_SELECT, readyLines, boardDate,
  CALL_SELECT, ITEM_SELECT, ITEM_RO_EMBED, PICK_SELECT, RECENT_DAYS, NOTE_MAX,
  callsByRo, noteLists, stamp, clearedLabel, roLabel, pickOptions, matchRos, upsertRow, actionError,
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
  let items = [];            // whiteboard_items rows, both kinds (open + recently cleared)
  let loaded = false, failed = false, handOk = false;
  const inFlight = {};       // line key → true while its request is out (buttons disabled)
  let readyErr = '';
  const fresh = {};         // item id pinned from the Desk pad → when it was first shown (null = not yet)
  const FRESH_MS = 4000;

  const el = document.createElement('div');
  el.className = 'wb';
  const handZone = (kind, id, title, placeholder) => `
            <section class="wz red" aria-labelledby="${id}" data-zone="${kind}">
              <h4 id="${id}">${title}</h4>
              <ul class="wz-list" data-z="list"></ul>
              <form class="wz-form${kind === 'parts' ? ' wz-form-parts' : ''}" data-z="form" hidden>
                ${kind === 'parts' ? `
                <div class="wz-pick">
                  <input class="wz-input wz-pick-q" data-z="pickq" type="text" autocomplete="off"
                    placeholder="RO #, customer or vehicle (optional)" aria-label="Pick an RO (optional)">
                  <span class="wz-pick-chosen" data-z="chosen" hidden></span>
                  <ul class="wz-pick-list" data-z="picklist" role="listbox" hidden></ul>
                </div>` : ''}
                <input class="wz-input" data-z="input" type="text" maxlength="${NOTE_MAX}" autocomplete="off"
                  placeholder="${placeholder}" aria-label="Write on the board">
                <button type="submit" class="wz-link">save</button>
                <button type="button" class="wz-link" data-wb-act="cancel">cancel</button>
              </form>
              <p class="wz-err" data-z="err" hidden></p>
              <div class="wz-foot">
                <button type="button" class="wz-link" data-wb-act="write" hidden>+ write on board</button>
                <button type="button" class="wz-link" data-wb-act="cleared" hidden></button>
              </div>
              <ul class="wz-list wz-erased" data-z="cleared" hidden></ul>
            </section>`;
  el.innerHTML = `
      <div class="wb-body"><div class="wb-frame">
        <div class="wb-board">
          <div class="wb-title"><b>FRONT OFFICE</b><span data-wb="date"></span></div>
          <div class="wb-grid">
            ${handZone('parts', 'wbPartsH', 'WAITING ON PARTS', 'part · vendor · ETA…')}
            <section class="wz blue wz-wide" aria-labelledby="wbReadyH">
              <h4 id="wbReadyH">READY → CALL FOR PICKUP</h4>
              <ul class="wz-list" data-wb="ready"></ul>
              <p class="wz-err" data-wb="ready-err" hidden></p>
            </section>
            ${handZone('note', 'wbNotesH', "DON'T FORGET", 'write it on the board…')}
          </div>
        </div>
        <div class="wb-tray" aria-hidden="true"><i></i><i></i><i></i></div>
      </div></div>`;
  const scroller = el.querySelector('.wb-body');
  const frame = el.querySelector('.wb-frame');
  const readyList = el.querySelector('[data-wb="ready"]');
  const dateEl = el.querySelector('[data-wb="date"]');
  const AUTO = '<span class="wb-chip auto" title="Fills itself from the RO Board">⚡ auto</span>';
  const HAND = '<span class="wb-chip hand" title="Written by hand">✎ hand</span>';

  // The two hand-written zones share one set of rules; only these differ.
  const Z = {};
  for (const kind of ['parts', 'note']) {
    const sec = el.querySelector(`[data-zone="${kind}"]`);
    const q = (k) => sec.querySelector(`[data-z="${k}"]`);
    Z[kind] = {
      kind, sec, list: q('list'), form: q('form'), input: q('input'), errEl: q('err'), clearedList: q('cleared'),
      writeBtn: sec.querySelector('[data-wb-act="write"]'), clearedBtn: sec.querySelector('[data-wb-act="cleared"]'),
      pickq: q('pickq'), chosenEl: q('chosen'), pickList: q('picklist'),
      err: '', showCleared: false,
      clearedWord: kind === 'parts' ? 'recently cleared' : 'recently erased',
      clearedText: kind === 'parts' ? (r) => clearedLabel(r) : (r) => `erased by ${stamp(r.cleared_by_name, r.cleared_at)}`,
    };
  }
  // The parts box's RO picker.
  const pick = { options: [], results: [], sel: 0, chosen: null, loading: false, err: '' };

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
    const re = el.querySelector('[data-wb="ready-err"]'); re.textContent = readyErr; re.hidden = !readyErr;
  }

  // A parts line starts with its RO (a link that opens it), then the note.
  function roPart(n) {
    if (n.kind !== 'parts' || !n.ro_id) return '';
    const label = n.ro ? roLabel(n.ro) : 'RO';
    return `<button type="button" class="wz-line wz-roref" data-wb-ro="${esc(n.ro_id)}" title="Open this RO">${esc(label)}</button> — `;
  }

  function drawHand(z) {
    const { open, erased } = noteLists(items, new Date(), z.kind);
    z.list.innerHTML = open.map((n) => {
      const off = inFlight[n.id] ? ' disabled' : '';
      const arrived = z.kind === 'parts'
        ? `<button type="button" class="wz-callbtn wz-arrived" data-wb-act="arrived" data-id="${esc(n.id)}"${off} title="The part came in — take it off the board">Arrived ✓</button>`
        : '';
      return `<li${n.id in fresh ? ' class="is-fresh"' : ''}>${HAND}<span class="wz-text">${roPart(n)}${esc(n.text)} <small class="wz-who">— ${esc(stamp(n.created_by_name, n.created_at))}</small>` +
        `${arrived}<button type="button" class="wz-x" data-wb-act="erase" data-id="${esc(n.id)}"${off} aria-label="Erase this line" title="Erase this line">×</button></span></li>`;
    }).join('') || (handOk ? '' : `<li class="wz-empty">${loaded ? '' : '…'}</li>`);
    z.writeBtn.hidden = !handOk || !z.form.hidden;
    z.clearedBtn.hidden = !handOk || !erased.length;
    z.clearedBtn.textContent = `${z.clearedWord} (${erased.length}) ${z.showCleared ? '▴' : '▾'}`;
    z.clearedBtn.setAttribute('aria-expanded', String(z.showCleared));
    z.clearedList.hidden = !z.showCleared || !erased.length;
    z.clearedList.innerHTML = erased.map((n) => {
      const off = inFlight[n.id] ? ' disabled' : '';
      const ro = n.kind === 'parts' && n.ro_id ? `${esc(n.ro ? roLabel(n.ro) : 'RO')} — ` : '';
      // Taken off because its RO closed (derived): no Undo — reopening the RO brings it back.
      const undo = n.auto === 'ro_closed' ? ''
        : `<button type="button" class="wz-link" data-wb-act="undo" data-id="${esc(n.id)}"${off}>Undo</button>`;
      return `<li${n.auto ? ' class="is-auto"' : ''}><span class="wz-text"><s>${ro}${esc(n.text)}</s> <small class="wz-who">${esc(z.clearedText(n))}</small>` +
        `${undo}</span></li>`;
    }).join('');
    z.errEl.textContent = z.err; z.errEl.hidden = !z.err;
  }

  function drawPick() {
    const z = Z.parts;
    const ch = pick.chosen;
    z.chosenEl.hidden = !ch;
    z.pickq.hidden = !!ch;
    z.chosenEl.innerHTML = ch
      ? `${esc(ch.label)} <button type="button" class="wz-x" data-wb-act="unpick" aria-label="No RO" title="No RO">×</button>` : '';
    const show = !ch && !z.form.hidden && document.activeElement === z.pickq;
    z.pickList.hidden = !show;
    if (!show) return;
    if (pick.loading && !pick.options.length) { z.pickList.innerHTML = '<li class="wz-pick-note">loading open ROs…</li>'; return; }
    if (pick.err) { z.pickList.innerHTML = `<li class="wz-pick-note">${esc(pick.err)}</li>`; return; }
    z.pickList.innerHTML = pick.results.map((o, i) =>
      `<li><button type="button" class="wz-pick-item${i === pick.sel ? ' is-sel' : ''}" role="option" aria-selected="${i === pick.sel}" data-wb-act="pick" data-id="${esc(o.id)}">${esc(o.label)}</button></li>`
    ).join('') || '<li class="wz-pick-note">no open RO matches — leave it empty for a shop order</li>';
  }

  function draw() {
    dateEl.textContent = boardDate();
    drawReady();
    drawHand(Z.parts);
    drawHand(Z.note);
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
          db.from('whiteboard_items').select(`${ITEM_SELECT}, ${ITEM_RO_EMBED}`).in('kind', ['note', 'parts'])
            .or(`cleared_at.is.null,cleared_at.gte.${since}`).order('created_at', { ascending: true }).limit(400),
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

  // The open ROs for the parts picker — read fresh each time the box opens.
  async function loadPick() {
    if (!db) return;
    pick.loading = true; pick.err = ''; drawPick();
    try {
      const { data, error } = await db.from('repair_orders').select(PICK_SELECT)
        .neq('status', 'closed').order('created_at', { ascending: false }).limit(400);
      if (error) throw error;
      pick.options = pickOptions(data);
    } catch (e) {
      console.warn('[Whiteboard] RO picker', e);
      pick.err = "couldn't load the ROs — you can still write the line without one";
    } finally {
      pick.loading = false;
      pick.results = matchRos(pick.options, Z.parts.pickq.value);
      pick.sel = 0;
      drawPick();
    }
  }

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
  const setReadyErr = (t) => { readyErr = t; };
  const foldItem = (r) => { if (r.item) items = upsertRow(items, keepRo(r.item)); };
  // The endpoint returns the bare row; keep the RO we already know so the line doesn't flicker.
  function keepRo(row) {
    if (!row || !row.ro_id) return row;
    const known = items.find((x) => x && x.ro_id === row.ro_id && x.ro);
    const chosen = pick.chosen && pick.chosen.id === row.ro_id ? pick.chosen.row : null;
    return { ...row, ro: (known && known.ro) || chosen || null };
  }

  function openForm(z) {
    z.form.hidden = false; z.err = '';
    if (z.kind === 'parts') {
      pick.chosen = null; z.pickq.value = '';
      draw(); drawPick();
      z.pickq.focus();
      loadPick();
    } else {
      draw();
      z.input.focus();
    }
  }
  function closeForm(z) {
    z.form.hidden = true; z.input.value = '';
    if (z.kind === 'parts') { pick.chosen = null; z.pickq.value = ''; drawPick(); }
    draw();
  }
  function choose(id) {
    const o = pick.options.find((x) => x.id === id);
    if (!o) return;
    pick.chosen = { id: o.id, label: o.label, row: o.row };
    drawPick();
    Z.parts.input.focus();
  }

  for (const z of Object.values(Z)) {
    z.form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = z.input.value.trim();
      if (!text) {
        if (z.kind === 'parts' && pick.chosen) { z.err = 'Write what part it’s waiting on.'; draw(); z.input.focus(); return; }
        closeForm(z); return;
      }
      const payload = { action: 'add', kind: z.kind, text };
      if (z.kind === 'parts' && pick.chosen) payload.ro_id = pick.chosen.id;
      z.input.disabled = true;
      const ok = await act('new:' + z.kind, payload, foldItem, (t) => { z.err = t; });
      z.input.disabled = false;
      // Saved → the box closes (Cris, 2026-09-24); "+ write on board" opens it again.
      // Not saved → it stays open with the text, so nothing typed is lost.
      if (ok) { closeForm(z); z.writeBtn.focus(); } else z.input.focus();
    });
    // Esc in the box closes the box only — not the whole drawer (the drawer skips a prevented Esc).
    z.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); closeForm(z); z.writeBtn.focus(); }
    });
  }

  // The RO search box: type to filter, ↑/↓ to move, Enter picks, Esc closes the box.
  const pq = Z.parts.pickq;
  pq.addEventListener('input', () => { pick.results = matchRos(pick.options, pq.value); pick.sel = 0; drawPick(); });
  pq.addEventListener('focus', drawPick);
  pq.addEventListener('blur', () => setTimeout(drawPick, 150));   // let a click on a result land first
  pq.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = pick.results.length;
      if (n) pick.sel = (pick.sel + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
      drawPick();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();                       // never submits from here
      const o = pick.results[pick.sel];
      if (o && pq.value.trim()) choose(o.id); else Z.parts.input.focus();
    } else if (ev.key === 'Escape') {
      ev.preventDefault(); closeForm(Z.parts); Z.parts.writeBtn.focus();
    }
  });

  el.addEventListener('mousedown', (ev) => {
    // Keep the search box focused while a result is clicked (so the list doesn't vanish first).
    if (ev.target.closest('[data-wb-act="pick"]')) ev.preventDefault();
  });

  el.addEventListener('click', (ev) => {
    const lineBtn = ev.target.closest('[data-wb-ro]');
    if (lineBtn) {
      // Click a Ready line / a parts line's RO → the RO opens the normal way (same path as global search).
      if (!window.cdOpenRo) return;
      const nav = document.querySelector('.sidebar-item[data-view="cdros"]'); if (nav) nav.click();
      window.cdOpenRo(lineBtn.dataset.wbRo);
      return;
    }
    const b = ev.target.closest('[data-wb-act]');
    if (!b || b.disabled) return;
    const id = b.dataset.id, ro = b.dataset.ro;
    const sec = b.closest('[data-zone]');
    const z = sec ? Z[sec.dataset.zone] : null;
    const zoneErr = (t) => { if (z) z.err = t; };
    switch (b.dataset.wbAct) {
      case 'write': if (z) openForm(z); return;
      case 'cancel': if (z) { closeForm(z); z.writeBtn.focus(); } return;
      case 'cleared': if (z) { z.showCleared = !z.showCleared; draw(); } return;
      case 'pick': choose(id); return;
      case 'unpick': pick.chosen = null; pq.value = ''; pick.results = matchRos(pick.options, ''); pick.sel = 0; drawPick(); pq.focus(); return;
      case 'erase': act(id, { action: 'clear', id, reason: 'erased' }, foldItem, zoneErr); return;
      case 'arrived': act(id, { action: 'clear', id, reason: 'arrived' }, foldItem, zoneErr); return;
      case 'undo': act(id, { action: 'undo', id }, foldItem, zoneErr); return;
      case 'call':
        act('ro:' + ro, { action: 'called', ro_id: ro }, (r) => { if (r.call) calls = upsertRow(calls, r.call, 'ro_id'); }, setReadyErr);
        return;
      case 'uncall':
        act('ro:' + ro, { action: 'uncalled', ro_id: ro }, (r) => { if (r.call) calls = upsertRow(calls, r.call, 'ro_id'); }, setReadyErr);
        return;
      default: return;
    }
  });

  // 📌 from the Desk pad: post the sticky's text as a Don't forget line. Resolves
  // { ok: true } only when the server stored it (the pad removes the sticky only then),
  // else { ok: false, error } in plain words — the sticky stays. Never throws.
  async function pinNote(text) {
    const r = await post({ action: 'add', kind: 'note', text });
    if (r.ok && r.body && r.body.item) {
      items = upsertRow(items, r.body.item);
      fresh[r.body.item.id] = null;
      if (ctx.isShown('board')) markFreshShown();
      draw();
      schedule();
      return { ok: true };
    }
    return { ok: false, error: actionError(r.status, r.body, "Couldn't pin it to the whiteboard — it's still here. Try again.") };
  }
  // The highlight runs FRESH_MS from the first time the line is actually on screen.
  function markFreshShown() {
    for (const id of Object.keys(fresh)) {
      if (fresh[id] !== null) continue;
      fresh[id] = Date.now();
      setTimeout(() => { delete fresh[id]; draw(); }, FRESH_MS);
    }
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
    onShow() { schedule(); markFreshShown(); return false; },
    pin: pinNote,
  };
}
