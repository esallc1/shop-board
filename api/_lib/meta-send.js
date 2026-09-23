/* ============================================================
   api/_lib/meta-send.js — ONE way to send a Messenger text from the server.
   Used by api/messenger.js (a reply typed in the tray) and api/meta-webhook.js
   (the after-hours auto-reply). Wiring: docs/wiring/meta-webhook.md §11, §12.

   graphSendText → POST graph.facebook.com/<ver>/<page>/messages with
   messaging_type RESPONSE, the Page token in the Authorization header (never
   the URL), 8 s timeout. `metadata` (≤ 1000 chars) is echoed back by Meta in
   the message_echoes delivery — that is how the webhook recognises the echo
   of our own auto-reply. Never throws: returns { mid } or { failure }.
   ============================================================ */

export const GRAPH = 'https://graph.facebook.com/v26.0';

// Meta's error body → the message a person sees. Never throws.
export function metaErrorMessage(err) {
  const e = (err && err.error) || err || {};
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  if (code === 190) {
    return { code, message: 'Facebook connection expired — the Page token no longer works. Tell Cris to reconnect Facebook. Nothing was sent.' };
  }
  if (code === 10 && sub === 2018278) {
    return { code, message: "Facebook refused: it's been more than 24 hours since the customer's last message. Call them instead." };
  }
  if (code === 551 || sub === 1545041) {
    return { code, message: "Facebook refused: this person isn't available on Messenger right now. Nothing was sent." };
  }
  const raw = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : 'Facebook refused the message.';
  return { code: Number.isFinite(code) ? code : null, message: `Facebook refused the message: ${raw.slice(0, 300)}` };
}

export async function graphSendText({ pageId, psid, text, token, metadata, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const message = { text };
  if (typeof metadata === 'string' && metadata) message.metadata = metadata.slice(0, 1000);
  try {
    const r = await doFetch(`${GRAPH}/${encodeURIComponent(pageId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: 'RESPONSE', message }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && typeof j.message_id === 'string' && j.message_id) return { mid: j.message_id };
    return { failure: metaErrorMessage(j) };
  } catch (e) {
    return {
      failure: { code: null, message: "Couldn't reach Facebook, so the message may not have been sent. Check Messenger before trying again." },
      thrown: String((e && e.message) || e),
    };
  }
}
