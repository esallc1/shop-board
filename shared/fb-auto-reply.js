/* ============================================================
   fb-auto-reply.js — the Facebook after-hours auto-reply's rules. Pure.
   Wiring: docs/wiring/meta-webhook.md §12.

   • DEFAULT_AUTO_REPLY_TEXT — used whenever shop_settings.fb_auto_reply_text is
     empty. The SAME string is copied in shared/board-settings.js (a classic
     script that can't import this); a test keeps the two identical.
   • shouldAutoReply — the send decision for ONE new inbound customer message.
   • findUsPhone — a US phone number in a customer's message, as 10 digits.
   ============================================================ */
import { closedStretchStart } from './shop-hours.js';

export const MAX_AUTO_REPLY_CHARS = 2000;   // Messenger's text limit
export const AUTO_METADATA = 'crisdata:auto';   // sent with the reply; Meta echoes it back

export const DEFAULT_AUTO_REPLY_TEXT =
  "Thanks for messaging Lee Transmission! We're closed right now (Mon–Fri, 8am–5pm). Reply with your name, phone number, and your vehicle + what's going on, and we'll call you as soon as we open.\n" +
  '5583 Lee St, Unit 12, Lehigh Acres, FL 33971 — 24/7 key drop box at the front door.\n' +
  '\n' +
  '¡Gracias por escribir a Lee Transmission! En este momento estamos cerrados (lunes a viernes, 8am–5pm). Responda con su nombre, número de teléfono, y su vehículo + el problema, y le llamaremos en cuanto abramos.\n' +
  '5583 Lee St, Unit 12, Lehigh Acres, FL 33971 — buzón para llaves 24/7 en la puerta principal.';

// The text to send: what's saved in Settings, or the default when it's empty.
export function autoReplyText(saved) {
  const s = typeof saved === 'string' ? saved : '';
  return s.trim() ? s.slice(0, MAX_AUTO_REPLY_CHARS) : DEFAULT_AUTO_REPLY_TEXT;
}

const toMs = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) && typeof v === 'number' ? v : Date.parse(v)));

/**
 * Should this NEW inbound customer message get the auto-reply?
 * @param {object} a
 * @param {boolean} a.enabled          shop_settings.fb_auto_reply_on
 * @param {number}  a.atMs             when the customer sent it (Meta's timestamp)
 * @param {string?} a.closedYmd        shop_settings.shop_closed_on ("YYYY-MM-DD" or null)
 * @param {string|number?} a.lastAutoReplyAt   social_threads.last_auto_reply_at
 * @param {string|number?} a.lastStaffReplyAt  newest NON-auto outgoing message on the thread
 * @returns {{ send: boolean, reason: string, stretchStart: number|null }}
 */
export function shouldAutoReply(a) {
  const { enabled, atMs, closedYmd = null } = a || {};
  if (!enabled) return { send: false, reason: 'switched-off', stretchStart: null };
  if (!Number.isFinite(atMs)) return { send: false, reason: 'no-time', stretchStart: null };
  const stretchStart = closedStretchStart(atMs, closedYmd);
  if (stretchStart === null) return { send: false, reason: 'shop-open', stretchStart };
  const auto = toMs(a.lastAutoReplyAt);
  if (auto !== null && Number.isFinite(auto) && auto >= stretchStart) return { send: false, reason: 'already-replied-this-stretch', stretchStart };
  const staff = toMs(a.lastStaffReplyAt);
  if (staff !== null && Number.isFinite(staff) && staff >= stretchStart) return { send: false, reason: 'staff-replied-this-stretch', stretchStart };
  return { send: true, reason: 'closed', stretchStart };
}

/* ── Phone numbers in a customer's message ─────────────────────────────── */
// 10 digits (NANP: area code and exchange start 2–9), an optional +1 / 1 in
// front, any common separators: (239) 555-1234 · 239-555-1234 · 239.555.1234 ·
// 2395551234 · +1 239 555 1234. Never part of a longer run of digits (a VIN, an
// RO number, a long account number). Returns the first match as 10 digits.
const PHONE_RE = /(?<![\d])(?:\+?1[\s.\-]*)?\(?([2-9]\d{2})\)?[\s.\-]*([2-9]\d{2})[\s.\-]*(\d{4})(?![\d])/;
export function findUsPhone(text) {
  const m = PHONE_RE.exec(String(text == null ? '' : text));
  return m ? m[1] + m[2] + m[3] : null;
}
