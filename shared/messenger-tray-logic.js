/* ============================================================
   messenger-tray-logic.js — the Advisor inbox tray's rules, with no DOM.
   Messenger → Advisor tray, step 4 (read-only). Wiring: docs/wiring/messenger-tray.md.

   Pure functions only, so shared/messenger-tray-logic.test.js locks them and
   shared/messenger-tray.js (the DOM half) just draws what they decide.
   ============================================================ */

export const WINDOW_MS = 24 * 60 * 60 * 1000;   // same rule as api/messenger.js replyWindow

const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

// When the newest CUSTOMER message ARRIVED at CrisData. last_inbound_received_at is
// stamped by social_record_message on arrival; a row that predates that column (or
// was never stamped) falls back to Meta's send time, last_inbound_at.
export function inboundArrivedMs(thread) {
  if (!thread) return null;
  const r = ms(thread.last_inbound_received_at);
  return r !== null ? r : ms(thread.last_inbound_at);
}

// A thread WAITS (belongs in the tray) when nobody marked it done, or a customer
// message ARRIVED after it was marked done. Arrival, not Meta's send time: a message
// sent just before someone clicked Done but delivered just after must bring it back.
// Our own replies never do (they don't stamp the arrival).
export function isWaiting(thread) {
  if (!thread) return false;
  const done = ms(thread.done_at);
  if (done === null) return true;
  const arrived = inboundArrivedMs(thread);
  return arrived !== null && arrived > done;
}

// Waiting threads, newest activity first. Input never mutated.
export function waitingThreads(threads) {
  return (threads || []).filter(isWaiting)
    .sort((a, b) => (ms(b.last_message_at) || 0) - (ms(a.last_message_at) || 0));
}

// Who the row is: the linked customer's name > the Facebook name > "Facebook user".
// `customersById` = { [id]: { name } } — a linked customer that hasn't loaded falls
// through to the Facebook name rather than showing nothing.
export function threadName(thread, customersById) {
  const c = thread && thread.customer_id && customersById ? customersById[thread.customer_id] : null;
  const cn = c && typeof c.name === 'string' ? c.name.trim() : '';
  if (cn) return { name: cn, linked: true };
  const fb = thread && typeof thread.display_name === 'string' ? thread.display_name.trim() : '';
  if (fb) return { name: fb, linked: false };
  return { name: 'Facebook user', linked: false };
}

// The small reply-window indicator. Same 24h rule the server enforces.
export function windowLabel(lastInboundAt, nowMs = Date.now()) {
  const t = ms(lastInboundAt);
  if (t === null) return { open: false, text: 'No message from them yet' };
  const left = t + WINDOW_MS - nowMs;
  if (left <= 0) return { open: false, text: 'Reply window closed' };
  const h = Math.floor(left / 3600000);
  if (h >= 1) return { open: true, text: `${h}h left to reply` };
  return { open: true, text: `${Math.max(1, Math.floor(left / 60000))}m left to reply`, urgent: true };
}

// One line of preview text for a message.
export function previewText(msg) {
  if (!msg) return '';
  const text = typeof msg.text === 'string' ? msg.text.replace(/\s+/g, ' ').trim() : '';
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  let body = text;
  if (!body && atts.length) body = attachmentLabel(atts[0]);
  if (!body) body = '(no text)';
  if (msg.direction === 'out') body = (msg.send_status === 'failed' ? 'Not sent: ' : 'Shop: ') + body;
  return body.length > 90 ? body.slice(0, 89) + '…' : body;
}

// "📷 Photo", "🎬 Video", … — the label an attachment gets (the UI adds "— view").
export function attachmentLabel(att) {
  const type = att && typeof att.type === 'string' ? att.type : '';
  if (att && att.sticker_id) return '👍 Sticker';
  switch (type) {
    case 'image': return '📷 Photo';
    case 'video': return '🎬 Video';
    case 'audio': return '🎤 Voice message';
    case 'file': return '📎 File';
    case 'location': return '📍 Location';
    default: return att && att.title ? `🔗 ${att.title}` : '📎 Attachment';
  }
}

// The small line under a message saying who/how. `employeesById` = { [id]: { name } }.
export function messageByline(msg, employeesById) {
  if (!msg) return '';
  if (msg.direction !== 'out') return '';
  if (msg.source === 'page_inbox') return 'via Facebook app';
  const e = msg.sent_by && employeesById ? employeesById[msg.sent_by] : null;
  const who = e && e.name ? String(e.name).trim() : '';
  return who ? `CrisData · ${who}` : 'CrisData';
}

// A short time for the list: "now", "5m", "3h", "Mon", "Sep 21".
export function timeLabel(iso, nowMs = Date.now()) {
  const t = ms(iso);
  if (t === null) return '';
  const d = nowMs - t;
  if (d < 60000) return 'now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
  const dt = new Date(t);
  if (d < 6 * 86400000) return dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

// Did a refresh bring a NEW customer message? (→ the tray opens itself.) Compares
// the newest waiting ARRIVAL time against what we saw before. The first load
// (prev null) is never "new" — opening on page load is a separate rule.
export function newestInbound(threads) {
  let best = null;
  for (const t of waitingThreads(threads)) {
    const v = inboundArrivedMs(t);   // arrival — a late delivery still auto-opens
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}
export function hasNewInbound(prevNewest, nextNewest) {
  return prevNewest !== null && nextNewest !== null && nextNewest > prevNewest;
}

// The newest message per thread from a list of messages (any order).
export function latestByThread(messages) {
  const out = {};
  for (const m of messages || []) {
    if (!m || !m.thread_id) continue;
    const cur = out[m.thread_id];
    if (!cur || (ms(m.sent_at) || 0) > (ms(cur.sent_at) || 0)) out[m.thread_id] = m;
  }
  return out;
}

/* ── Step 5: the tray's actions (reply / link / done) ──────────────────── */

export const WINDOW_CLOSED_TEXT = 'Facebook only lets us reply within 24 hours of their last message — call them instead.';

// Can the viewer reply here, and if not, why (and is there a number to call)?
// `customer` = the linked customer ({ name, phone_primary, phone_secondary }) or null.
export function composeState(thread, customer, nowMs = Date.now()) {
  const w = windowLabel(thread && thread.last_inbound_at, nowMs);
  const phone = customer ? (customer.phone_primary || customer.phone_secondary || '') : '';
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  const tel = digits.length === 10 ? `tel:+1${digits}` : null;
  if (w.open) return { canReply: true, reason: '', tel };
  return { canReply: false, reason: WINDOW_CLOSED_TEXT, tel };
}

// What a failed api/messenger call means for the tray. `status` = HTTP status,
// `body` = the JSON (or null). Returns { banner, message }: banner = show the
// "Facebook isn't connected — tell Cris" bar (token dead / never set).
export function replyError(status, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (status === 401) return { banner: false, message: 'Your CrisData sign-in has expired — sign in again from CrisData, then resend.' };
  if (b.error === 'not_connected' || b.error === 'token_expired') {
    return { banner: true, message: typeof b.message === 'string' && b.message ? b.message : "Facebook isn't connected — tell Cris." };
  }
  if (b.error === 'window_closed') return { banner: false, message: WINDOW_CLOSED_TEXT };
  if (typeof b.message === 'string' && b.message) return { banner: false, message: b.message };
  if (typeof b.error === 'string' && b.error) return { banner: false, message: `Couldn't do that (${b.error}).` };
  return { banner: false, message: `Couldn't reach CrisData (HTTP ${status || '—'}). Try again.` };
}

// The Desk attach picker's search, same rules (advisor-board renderAttachList):
// no query → 30 most recently invoiced; else name/business contains the query,
// or ≥3 digits matching the last-10 of either phone; at most 60.
export function searchCustomers(list, q) {
  const l10 = (s) => String(s == null ? '' : s).replace(/\D/g, '').slice(-10);
  const all = Array.isArray(list) ? list : [];
  const query = String(q || '').trim().toLowerCase();
  if (!query) {
    return [...all].sort((a, b) => String(b.last_invoiced || '').localeCompare(String(a.last_invoiced || ''))).slice(0, 30);
  }
  const qDigits = query.replace(/\D/g, '');
  return all.filter((c) => {
    const name = ((c.business_name || '') + ' ' + (c.name || '')).toLowerCase();
    if (name.includes(query)) return true;
    if (qDigits.length >= 3) return l10(c.phone_primary).includes(qDigits) || l10(c.phone_secondary).includes(qDigits);
    return false;
  }).slice(0, 60);
}

// "CrisData · <name>" for our replies — the viewer's own name wins when the roster
// view doesn't carry them (employees_visible hides is_test accounts).
export function bylineWithViewer(msg, employeesById, viewer) {
  if (msg && msg.direction === 'out' && msg.source !== 'page_inbox' && viewer && viewer.id && viewer.name
      && msg.sent_by === viewer.id && !(employeesById && employeesById[viewer.id])) {
    return `CrisData · ${viewer.name}`;
  }
  return messageByline(msg, employeesById);
}
