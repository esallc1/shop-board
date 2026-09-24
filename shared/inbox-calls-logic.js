/* ============================================================
   inbox-calls-logic.js — the rules for incoming calls in the Inbox tray,
   with no DOM and no database. Wiring: docs/wiring/inbox-calls.md.
   The DOM half is shared/inbox-calls.js; the card itself (and every write it
   makes) is still the callerCard code in advisor-board.html.

   Slice 1 (Cris, 2026-09-24): the floating call cards moved INTO the tray.
   A call "rings" for RING_MS after it started (the pinned caller-ID card at the
   top of the tray); after that it's a row under "Needs handling" until someone
   closes it — per board, exactly like the old cards.
   ============================================================ */

export const RING_MS = 2 * 60 * 1000;

// When did this call start ringing? The call's own started_at when it's a real
// time not in the future (a little clock skew allowed); otherwise when this board
// got the card (a dry-run card, or a row with no started_at).
export function ringStartMs(call, addedAtMs) {
  const t = Date.parse(call && call.started_at);
  const added = Number(addedAtMs) || 0;
  if (Number.isFinite(t) && t <= (added || Date.now()) + 60 * 1000) return t;
  return added;
}

export function isRinging(startMs, nowMs = Date.now()) {
  const s = Number(startMs);
  return Number.isFinite(s) && s > 0 && nowMs - s < RING_MS;
}

// The one card that gets the pinned ringing slot: the NEWEST still-ringing card
// that nobody has opened yet (not in the detail view, not answered). Others that
// still ring show as rows marked "ringing". entries: [{ id, startMs, inDetail, answered }] → id | null.
export function pickRinging(entries, nowMs = Date.now()) {
  let best = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.inDetail || e.answered || !isRinging(e.startMs, nowMs)) continue;
    if (!best || e.startMs > best.startMs) best = e;
  }
  return best ? best.id : null;
}

// Newest first (plain order).
export function orderNewestFirst(entries) {
  return (Array.isArray(entries) ? entries.slice() : []).sort((a, b) => (Number(b.startMs) || 0) - (Number(a.startMs) || 0));
}

// "Needs handling" order (Cris, 2026-09-24): calls with NO NOTE YET on top (newest
// first), then the ones someone already noted (newest first). A call that ended
// with nobody typing anything drops to the top of the list — never away.
export function orderNeedsHandling(entries) {
  const list = orderNewestFirst(entries);
  return [...list.filter((e) => !e.noted), ...list.filter((e) => e.noted)];
}

// What a row calls the caller: the matched customer's name > the caller-ID name
// (CNAM) > the number.
export function callRowName({ customerName, cnam, number } = {}) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  return s(customerName) || s(cnam) || s(number) || '(unknown number)';
}

// The row's second line: "Direct · ringing" / "Facebook · needs handling" / "… · noted".
export function callRowStatus({ source, ringing, noted } = {}) {
  const st = ringing ? 'ringing' : (noted ? 'noted — close it when done' : 'no note yet');
  return [typeof source === 'string' && source.trim() ? source.trim() : '', st].filter(Boolean).join(' · ');
}

// Strip badge: the number of calls on this board, and whether one is ringing.
export function stripCalls(entries, nowMs = Date.now()) {
  const list = Array.isArray(entries) ? entries : [];
  return { count: list.length, ringing: list.some((e) => e && isRinging(e.startMs, nowMs)) };
}

/* ── The ringing caller-ID glance (mockup screen 1, Cris 2026-09-24) ─────── */
const STAGE = { estimate: 'Estimate', ro: 'Active RO', invoice: 'Ready for pickup', closed: 'Closed' };
const vehText = (v) => (v && typeof v === 'object' ? [v.year, v.make, v.model].filter((x) => x != null && String(x).trim() !== '').join(' ') : '');
const shortDate = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : '';
};

// Everything the pinned card shows, from what the call card already loaded.
//   call:     the calls row;  number: its formatted number;  source: "Direct" / "Facebook" / …
//   state:    'matched' | 'multi' | 'new' | 'loading'
//   customer: { id, name, business_name } (matched only)
//   vehicles: [{ year, make, model }];  ros: [{ ro_number, status, declined_at, created_at, closed_at, vehicles }]
// → { who, sub, phone, source, tag, vehicle, inShop, lastVisit, headsUp, customerId }
export function callerGlance({ call = {}, number = '', source = '', state = 'loading', customer = null, vehicles = [], ros = [] } = {}) {
  const cnam = typeof call.cnam === 'string' ? call.cnam.trim() : '';
  const phone = number || '';
  const base = { phone, source, customerId: customer && customer.id != null ? customer.id : null };
  if (state === 'loading') return { ...base, who: phone || '(unknown number)', sub: 'Looking up…', tag: '', vehicle: '', inShop: '', lastVisit: '', headsUp: '' };
  if (state === 'new') return { ...base, who: 'New caller', sub: cnam || 'No caller ID name', tag: 'New', vehicle: '', inShop: '', lastVisit: '', headsUp: '' };
  if (state === 'multi') return { ...base, who: phone || '(unknown number)', sub: 'Several customers on this number — pick one in the notepad', tag: '', vehicle: '', inShop: '', lastVisit: '', headsUp: '' };

  const c = customer || {};
  const who = (c.business_name || c.name || '(no name)').trim();
  const sub = c.business_name && c.name ? c.name : '';
  const list = Array.isArray(ros) ? ros.filter(Boolean) : [];
  const newest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  const open = list.filter((r) => r.status !== 'closed' && !r.declined_at).sort(newest);
  const closed = list.filter((r) => r.status === 'closed')
    .sort((a, b) => String(b.closed_at || b.created_at || '').localeCompare(String(a.closed_at || a.created_at || '')));
  const roLine = (r, parts) => [r.ro_number != null ? `RO #${r.ro_number}` : 'RO', ...parts].filter(Boolean).join(' · ');

  const inShop = open.length ? roLine(open[0], [vehText(open[0].vehicles), STAGE[open[0].status] || open[0].status]) : '';
  // Last visit (Cris, 2026-09-24): the most recent CLOSED RO — "RO #5890 · Mar 3". The RO in the
  // shop now never counts (it isn't closed). No closed RO → '' and the row is hidden.
  const lastVisit = closed.length
    ? [closed[0].ro_number != null ? `RO #${closed[0].ro_number}` : 'RO', shortDate(closed[0].closed_at || closed[0].created_at)].filter(Boolean).join(' · ')
    : '';

  const declined = list.filter((r) => r.declined_at);
  const estimates = list.filter((r) => r.status === 'estimate' && !r.declined_at);
  const headsUp = declined.length ? `Declined estimate ${declined.map((r) => '#' + (r.ro_number ?? '?')).join(', ')}`
    : (estimates.length ? `Open estimate ${estimates.map((r) => '#' + (r.ro_number ?? '?')).join(', ')}` : '');

  const vehs = Array.isArray(vehicles) ? vehicles : [];
  return {
    ...base, who, sub,
    tag: list.length ? 'Returning' : 'Customer',
    vehicle: vehs.length ? vehText(vehs[0]) + (vehs.length > 1 ? ` +${vehs.length - 1}` : '') : '',
    inShop, lastVisit, headsUp,
  };
}
