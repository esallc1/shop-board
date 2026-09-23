/* ============================================================
   desk-pad.js — the Desk pad on the advisor board (Front Desk redesign).
   Wiring: docs/wiring/desk-pad.md. Rules: shared/desk-pad-logic.js.

   A "📝 Desk pad" tab at the bottom middle of the work area, on EVERY advisor
   tab (mounted once on <body>, outside the views — like the Messenger tray).
   Opening it docks a lined pad at the bottom of the work area and PUSHES the
   page up to make room: .main-area gets bottom padding the pad's height and the
   window scrolls up by the same amount, so what was at the bottom of the screen
   stays visible just above the pad. Hide scrolls it back down. Below 900px it
   overlays instead (no push).

   HEIGHT (Cris, 2026-09-23): start short, grow as needed — the header plus ONE
   row of notes, growing a row at a time as notes wrap, capped at 45% of the
   window (then the notes scroll inside the pad). `padHeight` decides; a
   ResizeObserver re-applies it whenever the notes change size, and the push
   follows the real height (deleting notes shrinks the pad and the page comes
   back down by the same amount).

   Yellow sticky notes: × deletes, "+ New note", several at once, "Tear off
   page" clears them all (one inline confirm), "Hide ▾". N toggles the pad —
   never while typing. Esc hides it when focus is inside the pad.

   STORAGE: this computer only — localStorage via desk-pad-logic (every read and
   write can fail without breaking the pad). NOTHING in the database: this file
   takes no Supabase client and makes no network call (test-locked).
   ============================================================ */
import {
  loadNotes, saveNotes, addNote, deleteNote, updateNoteText, tearOff, isPadToggleKey,
  padHeight, pushScrollTarget,
} from './desk-pad-logic.js';

const TEAR_TEXT = 'Tear off this page? All notes will be removed.';
const PUSH_MIN_WIDTH = 900;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const getStorage = () => window.localStorage;   // may throw — the logic module catches it

export function mountDeskPad() {
  if (document.getElementById('dpad')) return null;

  let notes = loadNotes(getStorage);
  let open = false;
  let confirming = false;
  let pushedBy = 0;        // px the window has been scrolled by the pad (to undo on hide)
  let shownH = 0;          // the pad's height as last applied

  const root = document.createElement('div');
  root.id = 'dpad';
  root.className = 'dpad';
  root.innerHTML = `
    <button type="button" class="dpad-tab" data-dp="toggle" aria-expanded="false" aria-controls="dpadSheet" title="Desk pad (N)">
      📝 Desk pad <span class="dpad-count"></span><span class="dpad-kbd" aria-hidden="true">N</span>
    </button>
    <section class="dpad-sheet" id="dpadSheet" aria-label="Desk pad" hidden>
      <div class="dpad-top">
        <div class="dpad-ttl"><b>Desk pad</b><small>Scratch notes · this computer only</small></div>
        <div class="dpad-actions">
          <button type="button" class="dpad-btn is-primary" data-dp="new">+ New note</button>
          <button type="button" class="dpad-btn" data-dp="tear">Tear off page</button>
          <button type="button" class="dpad-btn is-ghost" data-dp="hide">Hide ▾</button>
        </div>
      </div>
      <div class="dpad-confirm" hidden>
        <span>${esc(TEAR_TEXT)}</span>
        <button type="button" class="dpad-btn is-danger" data-dp="tear-yes">Tear off</button>
        <button type="button" class="dpad-btn" data-dp="tear-no">Cancel</button>
      </div>
      <div class="dpad-body"><div class="dpad-grid"></div></div>
    </section>`;
  document.body.appendChild(root);
  const tab = root.querySelector('.dpad-tab');
  const count = root.querySelector('.dpad-count');
  const sheet = root.querySelector('.dpad-sheet');
  const scroller = root.querySelector('.dpad-body');
  const body = root.querySelector('.dpad-grid');
  const top = root.querySelector('.dpad-top');
  const confirmBar = root.querySelector('.dpad-confirm');

  function save() { saveNotes(getStorage, notes); }

  function drawCount() {
    count.textContent = notes.length ? String(notes.length) : '';
    count.hidden = !notes.length;
  }

  function drawNotes() {
    body.innerHTML = notes.map((n) => `
      <div class="dpad-note" data-note="${esc(n.id)}">
        <div class="dpad-note-head"><span>${esc(n.time)}</span>
          <button type="button" class="dpad-x" data-dp="del" data-id="${esc(n.id)}" aria-label="Throw this note away" title="Throw this note away">×</button></div>
        <textarea class="dpad-text" data-id="${esc(n.id)}" placeholder="Write anything…" aria-label="Note">${esc(n.text)}</textarea>
      </div>`).join('') +
      `<button type="button" class="dpad-add" data-dp="new">+ New note</button>`;
    drawCount();
    fitHeight();
  }

  function drawConfirm() { confirmBar.hidden = !confirming; if (open) fitHeight(); }

  const pushes = () => window.innerWidth >= PUSH_MIN_WIDTH;

  // Size the pad to its notes (padHeight), then move the page by the change so
  // the push always equals the pad's real height.
  function fitHeight() {
    if (!open) return;
    const cs = getComputedStyle(scroller);
    const chrome = top.offsetHeight + (confirmBar.hidden ? 0 : confirmBar.offsetHeight) + (parseFloat(getComputedStyle(sheet).borderTopWidth) || 0);
    const content = body.offsetHeight + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const h = padHeight(chrome, content, window.innerHeight);
    if (h === shownH) return;
    // Read the scroll BEFORE the padding changes: shrinking the padding can make the
    // browser pull the page back on its own, and the undo-amount must count that too.
    const before = window.scrollY;
    sheet.style.height = h + 'px';
    document.documentElement.style.setProperty('--dpad-h', h + 'px');
    if (pushes()) {
      window.scrollTo(0, pushScrollTarget(before, shownH, h));
      pushedBy += window.scrollY - before;
    }
    shownH = h;
  }

  function setOpen(next) {
    if (next === open) return;
    open = next;
    tab.setAttribute('aria-expanded', String(open));
    if (open) {
      sheet.hidden = false;
      document.body.classList.add('dpad-open');
      shownH = 0; pushedBy = 0;
      fitHeight();
    } else {
      confirming = false; confirmBar.hidden = true;
      if (pushedBy) window.scrollBy(0, -pushedBy);
      pushedBy = 0; shownH = 0;
      sheet.hidden = true;
      sheet.style.height = '';
      document.body.classList.remove('dpad-open');
      document.documentElement.style.removeProperty('--dpad-h');
    }
  }

  function newNote() {
    const r = addNote(notes);
    if (!r.note) return;
    notes = r.notes; save(); drawNotes();
    const ta = body.querySelector(`.dpad-text[data-id="${CSS.escape(r.note.id)}"]`);
    if (ta) ta.focus();
  }

  /* ── events ──────────────────────────────────────────────────────────── */
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-dp]');
    if (!b) return;
    switch (b.dataset.dp) {
      case 'toggle': setOpen(!open); return;
      case 'hide': setOpen(false); tab.focus(); return;
      case 'new': if (!open) setOpen(true); newNote(); return;
      case 'del': notes = deleteNote(notes, b.dataset.id); save(); drawNotes(); return;
      case 'tear': confirming = true; drawConfirm(); return;
      case 'tear-no': confirming = false; drawConfirm(); return;
      case 'tear-yes': notes = tearOff(); save(); confirming = false; drawConfirm(); drawNotes(); return;
      default: return;
    }
  });

  // Typing saves as you go — no redraw, so the caret never jumps.
  body.addEventListener('input', (ev) => {
    const ta = ev.target.closest('.dpad-text');
    if (!ta) return;
    notes = updateNoteText(notes, ta.dataset.id, ta.value);
    save();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open && root.contains(document.activeElement)) {
      ev.preventDefault();
      setOpen(false);
      tab.focus();
      return;
    }
    if (isPadToggleKey(ev, document.activeElement)) {
      ev.preventDefault();
      setOpen(!open);
      if (open) { const first = body.querySelector('.dpad-text'); if (first) first.focus(); }
    }
  });

  // Another tab on this computer changed the pad → follow it (unless typing here).
  window.addEventListener('storage', (ev) => {
    if (ev.key && ev.key !== 'cdDeskPad') return;
    if (root.contains(document.activeElement) && document.activeElement.classList.contains('dpad-text')) return;
    notes = loadNotes(getStorage); drawNotes();
  });

  // Notes wrapping to a new row / a row emptying → refit (the push follows).
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitHeight()).observe(body);

  // Window resize: refit (the cap is a share of the window height); crossing below
  // 900px undoes the push (overlay there).
  window.addEventListener('resize', () => {
    if (!open) return;
    if (!pushes() && pushedBy) { window.scrollBy(0, -pushedBy); pushedBy = 0; }
    fitHeight();
  });

  drawNotes();
  drawConfirm();
  return { open: () => setOpen(true), hide: () => setOpen(false) };
}
