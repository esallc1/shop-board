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

/* ── The N key ─────────────────────────────────────────────────────────── */
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

// Should this keydown toggle the pad? Only a bare N (either case), not held
// down, no modifier, and never while typing.
export function isPadToggleKey(ev, activeEl) {
  if (!ev || ev.defaultPrevented) return false;
  if (ev.key !== 'n' && ev.key !== 'N') return false;
  if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return false;
  if (isTypingTarget(activeEl) || isTypingTarget(ev.target)) return false;
  return true;
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
