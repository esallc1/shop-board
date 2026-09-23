/* ============================================================
   messenger-tray-logic.js — the Advisor inbox tray's rules, with no DOM.
   Messenger → Advisor tray, step 4 (read-only). Wiring: docs/wiring/messenger-tray.md.

   Pure functions only, so shared/messenger-tray-logic.test.js locks them and
   shared/messenger-tray.js (the DOM half) just draws what they decide.
   ============================================================ */

export const WINDOW_MS = 24 * 60 * 60 * 1000;   // same rule as api/messenger.js replyWindow

const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

// A thread WAITS (belongs in the tray) when nobody marked it done, or a customer
// wrote again after it was marked done. The only thing that brings a Done thread
// back is a newer CUSTOMER message — our own replies never do.
export function isWaiting(thread) {
  if (!thread) return false;
  const done = ms(thread.done_at);
  if (done === null) return true;
  const inbound = ms(thread.last_inbound_at);
  return inbound !== null && inbound > done;
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
  if (msg.direction === 'out') body = (msg.send_status === 'failed' ? 'Not sent: ' : 'You: ') + body;
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
// the newest waiting last_inbound_at against what we saw before. The first load
// (prev null) is never "new" — opening on page load is a separate rule.
export function newestInbound(threads) {
  let best = null;
  for (const t of waitingThreads(threads)) {
    const v = ms(t.last_inbound_at);
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
