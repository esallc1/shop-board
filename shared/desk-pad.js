/* ============================================================
   desk-pad.js — the Desk pad on the advisor board (Front Desk redesign).
   Wiring: docs/wiring/desk-pad.md. Rules: shared/desk-pad-logic.js.

   The "📝 Desk pad" PANEL of the bottom drawer (shared/bottom-drawer.js, which
   owns the tab, the push-up, the height, Hide and Esc). Key N. This file only
   builds the notes: yellow sticky notes on lined paper — × deletes,
   "+ New note", several at once, "Tear off page" clears them all (one inline
   confirm). Typing saves as you go.

   HEIGHT (Cris, 2026-09-23): start short, grow as needed — the drawer asks
   `measure()` for this panel's header (the tear-off confirm when shown) and the
   notes' natural height, and applies the one-row-to-45 % rule.

   STORAGE: this computer only — localStorage via desk-pad-logic (every read and
   write can fail without breaking the pad). NOTHING in the database: this file
   takes no Supabase client and makes no network call (test-locked).
   ============================================================ */
import {
  loadNotes, saveNotes, addNote, deleteNote, updateNoteText, tearOff, isPadToggleKey,
} from './desk-pad-logic.js';

const TEAR_TEXT = 'Tear off this page? All notes will be removed.';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const getStorage = () => window.localStorage;   // may throw — the logic module catches it

// Panel factory for mountBottomDrawer — `ctx` is the drawer's { refit, recount, show, isShown }.
export function createDeskPadPanel(ctx) {
  let notes = loadNotes(getStorage);
  let confirming = false;

  const el = document.createElement('div');
  el.className = 'dpad';
  el.innerHTML = `
      <div class="dpad-confirm" hidden>
        <span>${esc(TEAR_TEXT)}</span>
        <button type="button" class="dpad-btn is-danger" data-dp="tear-yes">Tear off</button>
        <button type="button" class="dpad-btn" data-dp="tear-no">Cancel</button>
      </div>
      <div class="dpad-body"><div class="dpad-grid"></div></div>`;
  const actions = document.createElement('div');
  actions.className = 'dpad-actions';
  actions.innerHTML = `
          <button type="button" class="dpad-btn is-primary" data-dp="new">+ New note</button>
          <button type="button" class="dpad-btn" data-dp="tear">Tear off page</button>`;
  const scroller = el.querySelector('.dpad-body');
  const body = el.querySelector('.dpad-grid');
  const confirmBar = el.querySelector('.dpad-confirm');

  function save() { saveNotes(getStorage, notes); }

  function drawNotes() {
    body.innerHTML = notes.map((n) => `
      <div class="dpad-note" data-note="${esc(n.id)}">
        <div class="dpad-note-head"><span>${esc(n.time)}</span>
          <button type="button" class="dpad-x" data-dp="del" data-id="${esc(n.id)}" aria-label="Throw this note away" title="Throw this note away">×</button></div>
        <textarea class="dpad-text" data-id="${esc(n.id)}" placeholder="Write anything…" aria-label="Note">${esc(n.text)}</textarea>
      </div>`).join('') +
      `<button type="button" class="dpad-add" data-dp="new">+ New note</button>`;
    ctx.recount();
    ctx.refit();
  }

  function drawConfirm() { confirmBar.hidden = !confirming; ctx.refit(); }

  function newNote() {
    const r = addNote(notes);
    if (!r.note) return;
    notes = r.notes; save(); drawNotes();
    const ta = body.querySelector(`.dpad-text[data-id="${CSS.escape(r.note.id)}"]`);
    if (ta) ta.focus();
  }

  /* ── events ──────────────────────────────────────────────────────────── */
  function onClick(ev) {
    const b = ev.target.closest('[data-dp]');
    if (!b) return;
    switch (b.dataset.dp) {
      case 'new': if (!ctx.isShown('pad')) ctx.show('pad'); newNote(); return;
      case 'del': notes = deleteNote(notes, b.dataset.id); save(); drawNotes(); return;
      case 'tear': confirming = true; drawConfirm(); return;
      case 'tear-no': confirming = false; drawConfirm(); return;
      case 'tear-yes': notes = tearOff(); save(); confirming = false; drawConfirm(); drawNotes(); return;
      default: return;
    }
  }
  el.addEventListener('click', onClick);
  actions.addEventListener('click', onClick);

  // Typing saves as you go — no redraw, so the caret never jumps.
  body.addEventListener('input', (ev) => {
    const ta = ev.target.closest('.dpad-text');
    if (!ta) return;
    notes = updateNoteText(notes, ta.dataset.id, ta.value);
    save();
  });

  // Another tab on this computer changed the pad → follow it (unless typing here).
  window.addEventListener('storage', (ev) => {
    if (ev.key && ev.key !== 'cdDeskPad') return;
    if (el.contains(document.activeElement) && document.activeElement.classList.contains('dpad-text')) return;
    notes = loadNotes(getStorage); drawNotes();
  });

  drawNotes();

  return {
    id: 'pad', label: 'Desk pad', icon: '📝', key: 'N',
    subtitle: 'Scratch notes · this computer only',
    isKey: isPadToggleKey,
    el, actions,
    observe: [body],
    count: () => notes.length,
    // Header = the tear-off confirm when shown; content = the notes grid + its padding.
    measure() {
      const cs = getComputedStyle(scroller);
      return {
        chrome: confirmBar.hidden ? 0 : confirmBar.offsetHeight,
        content: body.offsetHeight + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
      };
    },
    // Opened with N → straight into the first note.
    onShow(how) {
      if (how !== 'key') return false;
      const first = body.querySelector('.dpad-text');
      if (!first) return false;
      first.focus();
      return true;
    },
    onHide() { confirming = false; confirmBar.hidden = true; },
  };
}
