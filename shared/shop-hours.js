/* ============================================================
   shop-hours.js — is the shop open? (America/New_York, DST-correct). Pure.
   Wiring: docs/wiring/meta-webhook.md §12 (after-hours auto-reply).

   Open = Monday–Friday 8:00am–5:00pm shop time. Everything else is closed,
   weekends included. "Shop closed today" (shop_settings.shop_closed_on, a DATE)
   closes the WHOLE of that ET date — and only while that date is today, so it
   expires on its own at midnight ET.

   The "closed stretch" is the time since the shop was last open: the Friday
   5pm → Monday 8am weekend is ONE stretch; so is Tuesday 5pm → Wednesday 8am.
   The auto-reply goes out at most once per thread per stretch.

   Used by api/meta-webhook.js (server) and the tests; no DOM, no clock of its
   own — every function takes the instant it is asked about.
   ============================================================ */

export const SHOP_TZ = 'America/New_York';
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 17;
const DAY_MS = 86400000;

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

// Wall-clock parts of an instant in shop time.
export function etParts(ms) {
  const p = {};
  for (const x of FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WD.indexOf(p.weekday) };
}

// The shop-time date of an instant, "YYYY-MM-DD".
export function etYmd(ms) {
  const p = etParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

// ET-minus-UTC offset at an instant (ms).
function offsetAt(ms) {
  const p = etParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// The instant of a shop-time wall clock (y, m 1-12, d, h, mi). Two passes so a
// date on the other side of a DST change gets its own offset.
export function etToUtc(y, m, d, h, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return ms;
}

// Is the "shop closed today" switch in force at this instant?
export function closedTodayActive(closedYmd, ms) {
  return typeof closedYmd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(closedYmd) && closedYmd === etYmd(ms);
}

// When did the current closed stretch start? null = the shop is OPEN at `ms`.
// Walks back day by day (in shop time) to the most recent open window that has
// already begun: inside it → open; after it → the stretch began at its 5pm.
export function closedStretchStart(ms, closedYmd = null) {
  if (!Number.isFinite(ms)) return null;
  const today = etParts(ms);
  const todayYmd = etYmd(ms);
  if (typeof closedYmd !== 'string') closedYmd = null;
  for (let back = 0; back < 15; back++) {
    const cal = new Date(Date.UTC(today.y, today.m - 1, today.d - back));
    const y = cal.getUTCFullYear(), m = cal.getUTCMonth() + 1, d = cal.getUTCDate();
    const wd = cal.getUTCDay();
    if (wd === 0 || wd === 6) continue;                                   // weekend
    const ymd = `${y}-${pad(m)}-${pad(d)}`;
    // The "closed today" day was closed ALL day — today while the switch is in
    // force, and still in history after midnight (so Wed-closed → Thu 1am is
    // one stretch that began Tuesday 5pm, not a new one).
    if (ymd === closedYmd && ymd <= todayYmd) continue;
    const open = etToUtc(y, m, d, OPEN_HOUR);
    const close = etToUtc(y, m, d, CLOSE_HOUR);
    if (ms < open) continue;                                              // before that day's opening
    if (ms < close) return null;                                          // inside open hours
    return close;                                                         // closed since that 5pm
  }
  return ms - 14 * DAY_MS;                                                // (never: two weeks with no open day)
}

export function isShopOpen(ms, closedYmd = null) {
  return closedStretchStart(ms, closedYmd) === null;
}
