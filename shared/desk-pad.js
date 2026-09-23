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

   Yellow sticky notes: × deletes, "+ New note", several at once, "Tear off
   page" clears them all (one inline confirm), "Hide ▾". N toggles the pad —
   never while typing. Esc hides it when focus is inside the pad.

   STORAGE: this computer only — localStorage via desk-pad-logic (every read and
   write can fail without breaking the pad). NOTHING in the database: this file
   takes no Supabase client and makes no network call (test-locked).
   ============================================================ */
import {
  loadNotes, saveNotes, addNote, deleteNote, updateNoteText, tearOff, isPadToggleKey,
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
  let pushedBy = 0;        // px the window was scrolled when the pad opened (to undo on hide)

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
      <div class="dpad-body"></div>
    </section>`;
  document.body.appendChild(root);
  const tab = root.querySelector('.dpad-tab');
  const count = root.querySelector('.dpad-count');
  const sheet = root.querySelector('.dpad-sheet');
  const body = root.querySelector('.dpad-body');
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
  }

  function drawConfirm() { confirmBar.hidden = !confirming; }

  const pushes = () => window.innerWidth >= PUSH_MIN_WIDTH;

  function setOpen(next) {
    if (next === open) return;
    open = next;
    tab.setAttribute('aria-expanded', String(open));
    if (open) {
      sheet.hidden = false;
      document.body.classList.add('dpad-open');
      const h = sheet.offsetHeight || 0;
      document.documentElement.style.setProperty('--dpad-h', h + 'px');
      if (pushes() && h) {
        // Push the page up by the pad's height so nothing that was on screen goes under it.
        const before = window.scrollY;
        window.scrollBy(0, h);
        pushedBy = window.scrollY - before;
      } else {
        pushedBy = 0;
      }
    } else {
      confirming = false; drawConfirm();
      if (pushedBy) window.scrollBy(0, -pushedBy);
      pushedBy = 0;
      sheet.hidden = true;
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

  // Width crossing 900px while open: keep the push in step (overlay below 900 → undo the push).
  window.addEventListener('resize', () => {
    if (!open) return;
    const h = sheet.offsetHeight || 0;
    document.documentElement.style.setProperty('--dpad-h', h + 'px');
    if (!pushes() && pushedBy) { window.scrollBy(0, -pushedBy); pushedBy = 0; }
  });

  drawNotes();
  drawConfirm();
  return { open: () => setOpen(true), hide: () => setOpen(false) };
}
