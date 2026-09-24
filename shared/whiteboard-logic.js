/* ============================================================
   whiteboard-logic.js — the Whiteboard's rules, with no DOM and no database.
   Wiring: docs/wiring/whiteboard.md. The DOM half is shared/whiteboard.js.

   Slice 2 (Cris, 2026-09-24): the "Ready → call for pickup" zone is every RO
   whose repair_orders.status is 'invoice' — the RO Board's "Ready for pickup"
   column. Worked out fresh on every read, so a line leaves on its own when the
   RO is closed (status 'closed') and comes back if it is reopened to 'invoice'.
   Status only — never closed_at (kept on a reopen) and never the floor's
   pickup zone.
   ============================================================ */

export const READY_STATUS = 'invoice';

// The ONE read the Whiteboard makes for this zone (named columns, all present
// since the RO foundation migrations). Used by shared/whiteboard.js.
export const READY_SELECT = 'id, ro_number, po, status, created_at, customers(name), vehicles(year, make, model)';

// "2015 Ford F-150" — same shape as the RO Board card.
export function vehicleText(v) {
  if (!v || typeof v !== 'object') return '';
  return [v.year, v.make, v.model].filter((x) => x != null && String(x).trim() !== '').join(' ');
}

// Rows from the query → display lines, oldest RO first. Anything that is not
// status 'invoice' is dropped here too (a stale realtime refresh or a hand-made
// row can never put a closed RO on the board).
export function readyLines(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.status !== READY_STATUS) continue;
    if (r.id == null || seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    const num = r.po || r.ro_number;
    const c = r.customers && typeof r.customers === 'object' ? r.customers : {};
    out.push({
      id: String(r.id),
      number: num != null && String(num) !== '' ? '#' + String(num) : '#—',
      roNumber: r.ro_number != null ? String(r.ro_number) : '',
      po: r.po != null ? String(r.po) : '',
      customer: (c.name && String(c.name).trim()) || '—',
      vehicle: vehicleText(r.vehicles),
      created: r.created_at || '',
    });
  }
  out.sort((a, b) => String(a.created).localeCompare(String(b.created)) || a.number.localeCompare(b.number));
  return out;
}

// The date in red marker at the top right of the board — "THU 9/24", shop time.
export function boardDate(now = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric',
    }).formatToParts(now).map((x) => [x.type, x.value]));
    return `${String(p.weekday).toUpperCase()} ${p.month}/${p.day}`;
  } catch (e) {
    return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][now.getDay()] + ` ${now.getMonth() + 1}/${now.getDate()}`;
  }
}

/* ── Slices 3 + 4: "Called ✓" and Don't forget ─────────────────────────── */
// Rows come from whiteboard_pickup_calls / whiteboard_items (staff read); every
// write goes through api/whiteboard.js, which stamps who + when.

export const RECENT_DAYS = 7;          // "Recently erased" looks back this far
export const NOTE_MAX = 500;           // same cap as the endpoint + the table CHECK
export const CALL_SELECT = 'ro_id, called_at, called_by, called_by_name';
export const ITEM_SELECT = 'id, kind, text, ro_id, created_by_name, created_at, cleared_at, cleared_by_name, cleared_reason';
// Items are read with the RO embedded (ITEM_RO_EMBED, below) for the parts lines.

const SHOP_TZ = 'America/New_York';
function parts(d) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
}

// "2:14 PM" today · "Tue 2:14 PM" this week · "9/17" older. Shop time.
export function whenText(iso, now = new Date()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  try {
    const p = parts(d), n = parts(now);
    const time = `${p.hour}:${p.minute} ${p.dayPeriod}`;
    if (p.month === n.month && p.day === n.day && Math.abs(now - d) < 36 * 3600e3) return time;
    if (now - d < 6 * 24 * 3600e3) return `${p.weekday} ${time}`;
    return `${p.month}/${p.day}`;
  } catch (e) {
    return d.toLocaleString();
  }
}

// "Kevin · 2:14 PM" — the stamp shown after a line.
export function stamp(name, iso, now = new Date()) {
  const who = (name && String(name).trim()) || 'someone';
  const when = whenText(iso, now);
  return when ? `${who} · ${when}` : who;
}

// ro_id → call row, only the rows that are actually stamped (called_at set).
export function callsByRo(rows) {
  const m = new Map();
  if (!Array.isArray(rows)) return m;
  for (const r of rows) {
    if (r && r.ro_id != null && r.called_at) m.set(String(r.ro_id), r);
  }
  return m;
}

// Hand-written rows of one kind → { open, erased }. open = on the board, oldest
// first. erased = taken off in the last RECENT_DAYS, newest first — for Don't
// forget that's "erased"; for Waiting on parts it's "erased" AND "arrived"
// (both land in "recently cleared" with Undo).
export function noteLists(rows, now = new Date(), kind = 'note') {
  const open = [], erased = [];
  if (!Array.isArray(rows)) return { open, erased };
  const since = now.getTime() - RECENT_DAYS * 24 * 3600e3;
  const reasons = kind === 'parts' ? ['erased', 'arrived'] : ['erased'];
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.kind !== kind || r.id == null || seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    if (!r.cleared_at) open.push(r);
    else if (reasons.includes(r.cleared_reason) && Date.parse(r.cleared_at) >= since) erased.push(r);
  }
  open.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  erased.sort((a, b) => String(b.cleared_at).localeCompare(String(a.cleared_at)));
  return { open, erased };
}

// "arrived · Kevin · 2:14 PM" / "erased · Kevin · 2:14 PM" — how a cleared line reads.
export function clearedLabel(row, now = new Date()) {
  const what = row && row.cleared_reason === 'arrived' ? 'arrived' : 'erased';
  return `${what} · ${stamp(row && row.cleared_by_name, row && row.cleared_at, now)}`;
}

/* ── Slice 5: Waiting on parts — the RO part of a line + the RO picker ───── */
// Open ROs for the picker (never 'closed'). Named columns, read-only.
export const PICK_SELECT = 'id, ro_number, po, status, created_at, customers(name), vehicles(year, make, model)';
// The RO embedded on a parts line (whiteboard_items.ro_id → repair_orders).
export const ITEM_RO_EMBED = 'ro:repair_orders(id, ro_number, po, status, customers(name), vehicles(year, make, model))';

// "#6089 · Ford F-250 · JOSE RAMIREZ" — make + model (no year, like the mockup), then the customer.
export function roLabel(ro) {
  if (!ro || typeof ro !== 'object') return '';
  const num = ro.po || ro.ro_number;
  const v = ro.vehicles && typeof ro.vehicles === 'object' ? ro.vehicles : {};
  const veh = [v.make, v.model].filter((x) => x != null && String(x).trim() !== '').join(' ');
  const c = ro.customers && typeof ro.customers === 'object' ? ro.customers : {};
  const cust = c.name && String(c.name).trim();
  return [num != null && String(num) !== '' ? '#' + num : '#—', veh, cust].filter(Boolean).join(' · ');
}

// Rows from PICK_SELECT → picker options (open ROs only), newest first.
export function pickOptions(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.id == null || r.status === 'closed' || seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    const v = r.vehicles && typeof r.vehicles === 'object' ? r.vehicles : {};
    out.push({
      id: String(r.id),
      label: roLabel(r),
      nums: [r.po, r.ro_number].filter((x) => x != null && x !== '').map(String),
      hay: [r.customers && r.customers.name, v.year, v.make, v.model].filter((x) => x != null).join(' ').toLowerCase(),
      created: r.created_at || '',
      // The RO's own fields, shaped like ITEM_RO_EMBED — so a line just written shows its RO at once.
      row: { id: String(r.id), ro_number: r.ro_number, po: r.po, status: r.status, customers: r.customers || null, vehicles: r.vehicles || null },
    });
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return out;
}

// Search the picker: digits match the RO / PO number, words match customer + vehicle
// (every word must match). Empty query → the newest few. At most `max`.
export function matchRos(options, query, max = 8) {
  const list = Array.isArray(options) ? options : [];
  const q = String(query == null ? '' : query).trim().toLowerCase().replace(/^#/, '');
  if (!q) return list.slice(0, max);
  const words = q.split(/\s+/).filter(Boolean);
  const out = [];
  for (const o of list) {
    const ok = words.every((w) => (/^\d+$/.test(w) ? o.nums.some((n) => n.includes(w)) || o.hay.includes(w) : o.hay.includes(w)));
    if (ok) out.push(o);
    if (out.length >= max) break;
  }
  return out;
}

// Put one row the endpoint just returned into a list (replace by key, or add).
export function upsertRow(rows, row, key = 'id') {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!row || row[key] == null) return list;
  const i = list.findIndex((r) => r && String(r[key]) === String(row[key]));
  if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row);
  return list;
}

// The words shown when an action is refused (the endpoint's own message wins).
export function actionError(status, body, fallback = "Couldn't save that — try again.") {
  if (Number(status) === 401) return "Your CrisData sign-in isn't active on this page — log out and sign in again.";
  if (body && typeof body.message === 'string' && body.message) return body.message;
  return fallback;
}
