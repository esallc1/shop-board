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
