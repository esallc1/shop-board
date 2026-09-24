/* ============================================================
   desk-pad-logic.js — the Desk pad's rules, with no DOM and no database.
   Wiring: docs/wiring/desk-pad.md. The DOM half is shared/desk-pad.js.

   The picture (Cris, Sept 16): the big desk-pad calendar on a secretary's desk.
   Jot anything, tear off the page when it's full. Notes are NOT linked to
   anything and live on THIS COMPUTER ONLY (localStorage) — never the database.

   Pure functions over a plain notes array ({ id, text, time }), plus a storage
   wrapper that can never throw (private mode, blocked site data, quota).
   ============================================================ */

export const STORAGE_KEY = 'cdDeskPad';
export const MAX_NOTES = 200;
export const MAX_TEXT = 4000;

// "10:31" style, shop time. `now` is injectable for tests.
export function noteTime(now = new Date()) {
  try {
    return now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).replace(/\s?[AP]M$/i, '');
  } catch (e) {
    let h = now.getHours() % 12 || 12;
    return h + ':' + String(now.getMinutes()).padStart(2, '0');
  }
}

// Keep only well-formed notes (a hand-edited or old storage value can't break the pad).
export function cleanNotes(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const n of value) {
    if (!n || typeof n !== 'object') continue;
    const id = typeof n.id === 'string' || typeof n.id === 'number' ? String(n.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      text: typeof n.text === 'string' ? n.text.slice(0, MAX_TEXT) : '',
      time: typeof n.time === 'string' ? n.time.slice(0, 12) : '',
    });
    if (out.length >= MAX_NOTES) break;
  }
  return out;
}

// A new, empty note at the end. Returns { notes, note } — input never mutated.
export function addNote(notes, { now = new Date(), idGen } = {}) {
  const list = cleanNotes(notes);
  if (list.length >= MAX_NOTES) return { notes: list, note: null };
  const id = idGen ? String(idGen()) : `n${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const note = { id, text: '', time: noteTime(now) };
  return { notes: [...list, note], note };
}

export function deleteNote(notes, id) {
  return cleanNotes(notes).filter((n) => n.id !== String(id));
}

export function updateNoteText(notes, id, text) {
  const t = typeof text === 'string' ? text.slice(0, MAX_TEXT) : '';
  return cleanNotes(notes).map((n) => (n.id === String(id) ? { ...n, text: t } : n));
}

// "Tear off page" — a fresh, empty pad.
export function tearOff() {
  return [];
}

/* ── Storage that never throws ─────────────────────────────────────────── */
// `storage` = window.localStorage (or a test double). Getting the property itself
// can throw in some browsers, so callers pass a getter.
export function loadNotes(getStorage) {
  try {
    const s = typeof getStorage === 'function' ? getStorage() : getStorage;
    if (!s) return [];
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return cleanNotes(v && Array.isArray(v.notes) ? v.notes : v);
  } catch (e) {
    return [];
  }
}

// Returns true when saved, false when storage refused (the pad keeps working in memory).
export function saveNotes(getStorage, notes) {
  try {
    const s = typeof getStorage === 'function' ? getStorage() : getStorage;
    if (!s) return false;
    s.setItem(STORAGE_KEY, JSON.stringify({ v: 1, notes: cleanNotes(notes) }));
    return true;
  } catch (e) {
    return false;
  }
}

/* ── 📌 Whiteboard: MOVE a sticky to the shared whiteboard ─────────────── */
// The pad never talks to the network: the drawer hands it `pinFn(text)`, which
// posts the line (shared/whiteboard.js → /api/whiteboard) and resolves
// { ok: true } or { ok: false, error }. The sticky is removed ONLY after the
// server confirmed — a failure (offline, signed out, refused) keeps it, so
// nothing is lost. Same 500-character cap as the whiteboard (never cut silently).
export const PIN_MAX = 500;

// Can this note be pinned? { ok, text } (trimmed) or { ok: false, reason, message }.
export function pinCheck(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { ok: false, reason: 'empty', message: 'Nothing to pin — write something first.' };
  if (t.length > PIN_MAX) {
    return { ok: false, reason: 'too_long', message: `Too long for the whiteboard (${t.length} / ${PIN_MAX} characters) — shorten it first.` };
  }
  return { ok: true, text: t };
}

// Pin note `id`: check it, hand it to pinFn, and only on a confirmed success
// return the notes without it. Never throws. Input never mutated.
// → { notes, pinned: boolean, error: string }
export async function pinNoteFlow(notes, id, pinFn) {
  const list = cleanNotes(notes);
  const note = list.find((n) => n.id === String(id));
  if (!note) return { notes: list, pinned: false, error: '' };
  const c = pinCheck(note.text);
  if (!c.ok) return { notes: list, pinned: false, error: c.message };
  let r;
  try {
    r = typeof pinFn === 'function' ? await pinFn(c.text) : { ok: false, error: 'Pinning isn\'t available here.' };
  } catch (e) {
    r = { ok: false, error: '' };
  }
  if (r && r.ok === true) return { notes: deleteNote(list, id), pinned: true, error: '' };
  const err = (r && typeof r.error === 'string' && r.error) || "Couldn't pin it — it's still here. Try again.";
  return { notes: list, pinned: false, error: err };
}

/* ── The N and W keys (the bottom drawer's two tabs) ──────────────────── */
// Is focus somewhere the person is typing? Then N is a letter, never a shortcut.
export function isTypingTarget(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    // buttons / checkboxes don't take letters
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type);
  }
  return false;
}

// A bare letter key for one of the bottom drawer's tabs: that letter (either
// case), not held down, no modifier, and never while typing.
function isBareLetter(ev, activeEl, letter) {
  if (!ev || ev.defaultPrevented) return false;
  if (String(ev.key || '').toLowerCase() !== letter) return false;
  if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return false;
  if (isTypingTarget(activeEl) || isTypingTarget(ev.target)) return false;
  return true;
}

// Should this keydown toggle the pad? Only a bare N (either case), not held
// down, no modifier, and never while typing.
export function isPadToggleKey(ev, activeEl) {
  return isBareLetter(ev, activeEl, 'n');
}

// Should this keydown toggle the Whiteboard tab of the same drawer? A bare W —
// the same guards as N (typing, modifiers, key repeat).
export function isBoardToggleKey(ev, activeEl) {
  return isBareLetter(ev, activeEl, 'w');
}

/* ── Height: start short, grow as needed (Cris, 2026-09-23) ────────────── */
// The pad is its header ("chrome": the top bar + the tear-off confirm when shown)
// plus the notes' natural height — one row to start — capped at CAP_RATIO of the
// window; beyond the cap the notes scroll inside the pad. It never goes below
// the header + one row of notes, even on a very short window.
export const CAP_RATIO = 0.45;
export const ONE_ROW_MIN = 132;   // a sticky (112) + the grid's padding (2 × 10)

export function padHeight(chromeH, contentH, viewportH, capRatio = CAP_RATIO) {
  const chrome = Math.max(0, Math.round(Number(chromeH) || 0));
  const content = Math.max(ONE_ROW_MIN, Math.round(Number(contentH) || 0));
  const cap = Math.max(chrome + ONE_ROW_MIN, Math.round((Number(viewportH) || 0) * capRatio));
  return Math.min(chrome + content, cap);
}

// Where the page should scroll when the pad's height changes from `prevH` to
// `nextH` while it pushes: by the same amount, never above the top.
export function pushScrollTarget(scrollY, prevH, nextH) {
  return Math.max(0, Math.round((Number(scrollY) || 0) + (Number(nextH) || 0) - (Number(prevH) || 0)));
}
