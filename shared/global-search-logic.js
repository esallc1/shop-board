/* ============================================================
   global-search-logic.js — the advisor board's one search box, without DOM or DB.
   Wiring: docs/wiring/global-search.md. The DOM half is shared/global-search.js.

   One box finds FOUR kinds of thing (Cris, 2026-09-23):
     customers  — name / business name, or phone (last-10 digits)
     vehicles   — plate or VIN            → opens the OWNER's record
     ROs        — repair_orders.ro_number OR .po (old ALLDATA / 5xxx numbers)
     call notes — calls.note / calls.outcome_note, every word must appear
   Pure functions only: what was typed, which queries to run, how to rank and
   group, and where a picked result goes. Tested by global-search-logic.test.js.
   ============================================================ */

export const GROUP_LABELS = { customer: 'Customers', vehicle: 'Vehicles', ro: 'ROs', call: 'Call notes' };
export const PER_GROUP = 5;

const last10 = (s) => String(s == null ? '' : s).replace(/\D/g, '').slice(-10);

// Words safe to put inside a PostgREST filter: letters, digits and a few joiners.
// Anything else ( , . ( ) * " \ : …) would break the or=(…) syntax or act as a
// wildcard, so it becomes a space. Lower-cased; empty words dropped.
export function safeWords(q) {
  return String(q == null ? '' : q)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#'\-]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[#'\-]+|[#'\-]+$/g, ''))
    .filter(Boolean);
}

// What did they type? Decides which of the four queries run and which group
// leads. Never throws.
export function classifyQuery(raw) {
  const q = String(raw == null ? '' : raw).trim();
  const digits = q.replace(/\D/g, '');
  const compact = q.replace(/[^A-Za-z0-9]/g, '');           // plate / VIN form
  const words = safeWords(q);
  const hasLetters = /\p{L}/u.test(q);
  const numberOnly = q !== '' && /^[\s#()+\-.\d]*$/.test(q) && digits.length > 0;
  const vinLike = /^[A-HJ-NPR-Z0-9]{17}$/i.test(compact);
  // Letters AND digits, 4–8 characters, no run of 5+ letters (a word) — a plate
  // ("XEE 683", "KXR4471", "HZPE46"); "2016 chevy" is a year and a word, not a plate.
  const plateLike = !vinLike && /[A-Za-z]/.test(compact) && /\d/.test(compact)
    && compact.length >= 4 && compact.length <= 8 && !/[A-Za-z]{5,}/.test(compact);
  const out = {
    q, digits, compact, words, hasLetters, numberOnly, vinLike, plateLike,
    customers: q.length >= 2,
    // A phone match only when what was typed IS a number: the "683" in plate
    // "XEE 683" must not pull in every customer whose phone contains 683.
    phone: numberOnly && digits.length >= 3,
    vehicles: compact.length >= 3,
    ros: numberOnly && digits.length >= 2 && digits.length <= 8,
    calls: hasLetters && words.join('').length >= 3,
    lead: 'customer',
  };
  if (vinLike || plateLike) out.lead = 'vehicle';
  else if (out.ros && digits.length <= 5) out.lead = 'ro';   // 6012, 5473
  else if (numberOnly) out.lead = 'customer';               // 7–10 digits = a phone
  return out;
}

// Group order for this query: the likely kind first, the rest in the fixed order.
export function groupOrder(cls) {
  const base = ['customer', 'vehicle', 'ro', 'call'];
  const lead = cls && base.includes(cls.lead) ? cls.lead : 'customer';
  return [lead, ...base.filter((k) => k !== lead)];
}

const custName = (c) => ((c && c.business_name ? c.business_name + ' ' : '') + ((c && c.name) || '')).trim();

// Customers from the cached, archive-filtered list — the SAME match rule the
// Customers tab search used (name/business contains, or ≥3 digits in either
// phone's last 10), ranked: exact phone > name starts with > name contains >
// phone contains. `archived` rows are dropped defensively.
export function searchCustomerList(list, cls, isArchived = (c) => !!(c && c.archived_at != null)) {
  if (!cls || !cls.customers) return [];
  const q = cls.q.toLowerCase();
  const qd = cls.digits;
  const scored = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || isArchived(c)) continue;
    const name = custName(c).toLowerCase();
    const p1 = last10(c.phone_primary), p2 = last10(c.phone_secondary);
    let score = 0;
    if (qd.length === 10 && (p1 === qd || p2 === qd)) score = 4;
    else if (cls.hasLetters && name && (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q)))) score = 3;
    else if (cls.hasLetters && name.includes(q)) score = 2;
    else if (cls.phone && (p1.includes(qd) || p2.includes(qd))) score = 1;
    if (score) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || custName(a.c).localeCompare(custName(b.c)));
  return scored.map((s) => s.c);
}

// The server-side filters (read-only, limited) in supabase-js form: each string
// is the inside of one .or(…); several .or() calls on a query are AND-ed.
// Plates: the typed pieces joined by * so "KXR 4471" finds "KXR 4471" and "KXR4471".
export function vehicleOr(cls) {
  if (!cls || !cls.vehicles) return null;
  const pieces = cls.q.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const loose = pieces.join('*');
  const forms = [...new Set([cls.compact, loose].filter((f) => f && f.replace(/\*/g, '').length >= 3))];
  return forms.flatMap((f) => [`plate.ilike.*${f}*`, `vin.ilike.*${f}*`]).join(',');
}
// RO number exactly, or the old PO (ALLDATA / 5xxx) starting with the digits.
export function roOr(cls) {
  if (!cls || !cls.ros) return null;
  const n = Number(cls.digits);
  const parts = [`po.ilike.${cls.digits}*`];
  if (Number.isSafeInteger(n)) parts.unshift(`ro_number.eq.${n}`);
  return parts.join(',');
}
// Call notes: one .or() per word → every word must appear, in either column.
export function callOrs(cls) {
  if (!cls || !cls.calls) return [];
  return cls.words.filter((w) => w.length >= 2).slice(0, 6)
    .map((w) => `note.ilike.*${w}*,outcome_note.ilike.*${w}*`);
}

// A short bit of the note around the first matched word (for the result line).
export function noteSnippet(text, words, width = 70) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const low = t.toLowerCase();
  let at = -1;
  for (const w of words || []) { const i = low.indexOf(String(w).toLowerCase()); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at <= 20 || t.length <= width) return t.length > width ? t.slice(0, width - 1) + '…' : t;
  const start = Math.max(0, at - 20);
  const s = t.slice(start, start + width - 2);
  return '…' + s + (start + width - 2 < t.length ? '…' : '');
}

// "RO #6012 · PO 5473" — both when both exist and differ.
export function roLabel(r) {
  const parts = [];
  if (r && r.ro_number != null) parts.push(`RO #${r.ro_number}`);
  if (r && r.po && String(r.po) !== String(r.ro_number)) parts.push(`PO ${r.po}`);
  return parts.join(' · ') || 'RO';
}

// Where a picked result goes (Cris, 2026-09-23). Never auto-opens a GUESSED
// customer: an unattached call opens in the call log, where the phone match is
// offered as a suggestion to confirm.
export function destination(kind, item, { mergedIntoId } = {}) {
  if (!item) return { to: 'none' };
  if (kind === 'customer') return { to: 'customer', id: String(item.id) };
  if (kind === 'vehicle') {
    const owner = item.owner || null;
    const keeper = owner && mergedIntoId ? mergedIntoId(owner) : null;
    const id = keeper || (owner && owner.id) || item.customer_id;
    return id ? { to: 'customer', id: String(id) } : { to: 'none' };
  }
  if (kind === 'ro') return { to: 'ro', id: String(item.id) };
  if (kind === 'call') {
    if (item.customer_id) return { to: 'customer-call', id: String(item.customer_id), callId: String(item.id) };
    if (item.started_at) return { to: 'call-log', when: item.started_at, callId: String(item.id) };
    return { to: 'desk' };
  }
  return { to: 'none' };
}

// The flat list the arrow keys walk: groups in order, PER_GROUP each.
export function flattenGroups(groups, order) {
  const out = [];
  for (const kind of order || []) {
    const items = (groups && groups[kind]) || [];
    items.slice(0, PER_GROUP).forEach((item) => out.push({ kind, item }));
  }
  return out;
}

// ↑/↓ with wrap-around; -1 = nothing selected.
export function moveSelection(index, delta, count) {
  if (!count) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}
