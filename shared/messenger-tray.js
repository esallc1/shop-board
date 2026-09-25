/* ============================================================
   messenger-tray.js — the Advisor inbox tray (Messenger steps 4 + 5; incoming
   CALLS since slice 1 of "calls into the tray", 2026-09-24).
   Wiring: docs/wiring/messenger-tray.md (+ inbox-calls.md for the calls area).
   Rules: shared/messenger-tray-logic.js.

   CALLS: the tray has a calls area above the Facebook list (shared/inbox-calls.js):
   the pinned ringing card + "Needs handling" rows + the opened card. The card
   itself is still the callerCard code in advisor-board.html; it hands each new
   card to window.cdCallInbox.add (queued in window.cdCallInboxPending until this
   mounts). A new call OPENS the tray — from hidden or tucked. The tray only hides
   when no Facebook thread waits AND no call is on this board. The strip shows a
   📞 badge + count next to the f. The old floating card stack is gone.

   Mounted ONCE by advisor-board.html, on <body>, outside every view — so it
   shows on every advisor tab. READS social_threads / social_messages with the
   signed-in Supabase session (staff_read policy: is_staff()). Every WRITE —
   reply, link / unlink, done — is a POST to /api/messenger through
   cdAuthFetch (the same session as a bearer token); the browser never writes
   a social_* row itself. No anon fallback.

   States (Cris, 2026-09-24 — the Front Desk Inbox mockup, screens 1/2/4):
     tucked  — the DEFAULT: a slim full-height strip on the right edge (📞 + f
               badges with counts) that PUSHES the board (never covers it). The
               tray folds back to it by itself when nothing is waiting.
     open    — the panel (calls + "Needs handling", or one call / conversation).
     hidden  — only before the first load.
     signin / notstaff / error — the strip with a "!" badge; opening it says why.
   OPENS BY ITSELF ONLY FOR SOMETHING NEW while the page is open (Cris,
   2026-09-24): a ringing call, or a newly arrived customer message. A page load /
   new tab stays folded even with items waiting (the badges show them). It folds
   back by itself when the last waiting item is handled.
   A thread whose 24 h reply window closed stops counting as waiting: it moves to a
   collapsed "Can't reply anymore" section at the bottom (Call them / Done); a new
   customer message brings it back to "Needs handling".

   The reply box lives OUTSIDE the redrawn area, so a realtime refresh never
   wipes what someone is typing. Drafts are kept per conversation.

   Refresh: realtime on both tables + a 60-second catch-up.

   ONE "Needs handling" list (slice 2a, 2026-09-25): the call rows (from the calls
   area, rows()) and the waiting Facebook threads are merged by
   mergeNeedsHandling — nobody-answered-yet on top, then the rest, newest first —
   and drawn here, in the body, by drawList. Every redraw goes through draw():
   the Facebook load, realtime, the 5 s call tick and every tap. A BACKGROUND
   redraw waits while someone has keyboard focus on a row (and the list HTML is
   only replaced when it actually changed). The call cards themselves never live
   in the list — a row just opens its card (callSlot.open), so a typed note is
   never touched by a redraw.
   ============================================================ */
import { mountCallSlot } from './inbox-calls.js';
import {
  lastStaffReplyByThread, mergeNeedsHandling, waitingCount, stripBadges,
  uiAfterLoad, uiAfterCallChange, deferListRedraw,
} from './inbox-list-logic.js';
import {
  splitWaiting, callLink, threadName, windowLabel, previewText, attachmentLabel,
  timeLabel, newestInbound, hasNewInbound, latestByThread,
  composeState, replyError, searchCustomers, bylineWithViewer, matchPhoneToCustomer,
} from './messenger-tray-logic.js';

const CATCH_UP_MS = 60 * 1000;
const API = '/api/messenger';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : null;
const fmtPhone = (p) => (typeof window.formatPhone === 'function' ? window.formatPhone(p) : p) || '';


export function mountMessengerTray({ db, viewer }) {
  if (!db || document.getElementById('mtray')) return;
  const me = () => { try { return (typeof viewer === 'function' && viewer()) || null; } catch (e) { return null; } };

  const root = document.createElement('div');
  root.id = 'mtray';
  root.className = 'mtray';
  root.innerHTML = `
    <button type="button" class="mtray-strip" aria-label="Open the inbox">
      <span class="mtray-ph" aria-hidden="true">📞</span><span class="mtray-pcount" hidden></span>
      <span class="mtray-fb" aria-hidden="true">f</span><span class="mtray-count"></span>
      <span class="mtray-vlabel" aria-hidden="true">Inbox</span>
    </button>
    <aside class="mtray-panel" aria-label="Inbox — calls and Facebook messages">
      <div class="mtray-head">
        <div class="mtray-title">Inbox<small></small></div>
        <button type="button" class="mtray-iconbtn" data-act="tuck" title="Tuck the tray away">Hide »</button>
      </div>
      <div class="mtray-banner" hidden></div>
      <div class="mtray-calls" hidden></div>
      <div class="mtray-body"></div>
      <div class="mtray-compose" hidden>
        <div class="mtray-compose-closed" hidden></div>
        <div class="mtray-compose-err" hidden></div>
        <div class="mtray-compose-row">
          <textarea class="mtray-input" rows="2" maxlength="2000" placeholder="Reply on Facebook… (Enter sends, Shift+Enter new line)" aria-label="Reply"></textarea>
          <button type="button" class="mtray-send" data-act="send">Send</button>
        </div>
      </div>
      <div class="mtray-picker" hidden>
        <div class="mtray-picker-head">
          <span>Link to a customer</span>
          <button type="button" class="mtray-iconbtn" data-act="picker-close" aria-label="Close">×</button>
        </div>
        <input type="search" class="mtray-picker-search" placeholder="Search all customers by name or number…" autocomplete="off">
        <div class="mtray-picker-err" hidden></div>
        <div class="mtray-picker-list"></div>
      </div>
    </aside>`;
  document.body.appendChild(root);
  const $ = (sel) => root.querySelector(sel);
  const strip = $('.mtray-strip');
  const countEl = $('.mtray-count');
  const titleSmall = $('.mtray-title small');
  const banner = $('.mtray-banner');
  const body = $('.mtray-body');
  const compose = $('.mtray-compose');
  const composeClosed = $('.mtray-compose-closed');
  const composeErr = $('.mtray-compose-err');
  const input = $('.mtray-input');
  const sendBtn = $('.mtray-send');
  const picker = $('.mtray-picker');
  const pickerSearch = $('.mtray-picker-search');
  const pickerList = $('.mtray-picker-list');
  const pickerErr = $('.mtray-picker-err');
  let callSlot = null;        // the calls area (set below, once mounted)
  const phBadge = $('.mtray-ph');
  const callSection = $('.mtray-calls');
  const phCount = $('.mtray-pcount');

  const st = {
    mode: 'loading',           // loading | ok | signin | notstaff | error
    ui: 'hidden',              // hidden | open | tucked
    threads: [], waiting: [], stale: [], latest: {}, customers: {}, employees: null,
    lastStaff: {},             // threadId → ms of the newest staff reply (who spoke last)
    listShown: '',             // the list HTML on screen — replaced only when it changed
    listDirty: false,          // a background redraw waited for keyboard focus to leave
    showStale: false,          // the "Can't reply anymore" section is collapsed until clicked
    lastCount: 0,              // waiting threads + calls at the last decision (auto-fold on the drop to 0)
    openThreadId: null, threadMsgs: [], newest: null, loadedOnce: false, loadedOnceBefore: false,
    errorText: '', staffChecked: false,
    drafts: {},                // threadId → unsent text
    sending: false, busy: null, // busy = 'link' | 'unlink' | 'done' while a header action runs
    confirmUnlink: false, headErr: '', composeErrText: '', bannerText: '',
    allCustomers: null,
  };

  /* ── API ──────────────────────────────────────────────────────────────── */
  async function callApi(payload) {
    if (typeof window.cdAuthFetch !== 'function') return { status: 0, body: { error: 'no-auth-fetch', message: 'This board is missing its sign-in helper — reload the page.' } };
    try {
      const r = await window.cdAuthFetch(db, API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      return { status: r.status, ok: r.ok, body: j };
    } catch (e) {
      return { status: 0, body: null };
    }
  }

  /* ── drawing ─────────────────────────────────────────────────────────── */
  function setUi(ui) {
    st.ui = ui;
    root.classList.toggle('is-open', ui === 'open');
    root.classList.toggle('is-tucked', ui === 'tucked');
    document.body.classList.toggle('mtray-open', ui === 'open');
    document.body.classList.toggle('mtray-tucked', ui === 'tucked');   // the strip pushes the board too
    if (ui !== 'open') closePicker();
  }

  function drawStrip() {
    const c = callSlot ? callSlot.strip() : { count: 0, ringing: false };
    const b = stripBadges({ mode: st.mode, fbActive: st.waiting.length, calls: c });
    phBadge.classList.toggle('is-off', b.phone.off);
    phCount.hidden = b.phone.hidden;
    phCount.textContent = b.phone.text;
    strip.classList.toggle('is-ringing', b.phone.ringing);
    const calls = c.count ? `${c.count} call${c.count === 1 ? '' : 's'}${c.ringing ? ' (ringing)' : ''} · ` : '';
    countEl.textContent = b.fb.text;
    countEl.hidden = b.fb.hidden;
    countEl.classList.toggle('is-note', b.fb.note);
    if (b.fb.off !== null) $('.mtray-fb').classList.toggle('is-off', b.fb.off);
    strip.title = st.mode === 'ok'
      ? `${calls}${st.waiting.length} Facebook conversation${st.waiting.length === 1 ? '' : 's'} waiting`
      : `${calls}Facebook messages — sign in from CrisData to see them`;
  }

  function drawBanner() {
    banner.hidden = !st.bannerText;
    banner.textContent = st.bannerText ? `⚠ ${st.bannerText}` : '';
  }

  // The ONE "Needs handling" list: call rows + Facebook threads, merged (slice 2a).
  // Call rows keep working when Facebook can't load (sign-in / permission / error):
  // the Facebook note then sits under them.
  function listHtml() {
    const now = Date.now();
    let fbNote = '';
    if (st.mode === 'signin') {
      fbNote = `<div class="mtray-note"><strong>Sign in from CrisData to see Facebook messages.</strong>This board was opened without a CrisData sign-in, so it can't read the shop's Facebook conversations. Log out and sign in again from the CrisData front door.</div>`;
    } else if (st.mode === 'notstaff') {
      fbNote = `<div class="mtray-note"><strong>This sign-in can't see Facebook messages.</strong>Only active CrisData employees can. Ask Cris to check your login.</div>`;
    } else if ((st.mode === 'error' || st.mode === 'loading') && !st.loadedOnce) {
      fbNote = st.mode === 'loading' ? '' : `<div class="mtray-note"><strong>Couldn't load Facebook messages.</strong>${esc(st.errorText)} — it will try again within a minute.</div>`;
    }
    const fbReady = !fbNote && st.loadedOnce;
    const items = mergeNeedsHandling({
      calls: callSlot ? callSlot.rows(now) : [],
      threads: fbReady ? st.waiting : [],
      lastStaff: st.lastStaff,
    });
    const warn = st.mode === 'error' && st.loadedOnce ? `<div class="mtray-warn">Couldn't refresh just now — showing what was last loaded.</div>` : '';
    let html = warn;
    if (items.length) {
      html += '<div class="mtray-sec">Needs handling</div>' + items.map((it) => (it.kind === 'call' ? it.ref.html : threadRowHtml(it.ref, it.fresh, now))).join('');
    }
    if (fbNote) return html + fbNote;
    if (!fbReady) return html;
    if (!st.waiting.length) {
      html += calls()
        ? `<div class="mtray-note is-small">No Facebook messages waiting.</div>`
        : `<div class="mtray-note"><strong>All caught up.</strong>New calls and Facebook messages will show here.</div>`;
    }
    return html + staleHtml();
  }

  // A Facebook row. The time is when the CUSTOMER's last message arrived (what the
  // list sorts by) — our own reply never makes a thread look newer.
  function threadRowHtml(t, fresh, now) {
    const who = threadName(t, st.customers);
    const w = windowLabel(t.last_inbound_at, now);
    const winCls = !w.open ? 'is-closed' : (w.urgent ? 'is-urgent' : '');
    const arrived = t.last_inbound_received_at || t.last_inbound_at || t.last_message_at;
    return `<button type="button" class="mtray-row${fresh ? ' is-unanswered' : ''}" data-thread="${esc(t.id)}">
        <div class="mtray-row-top"><span class="mtray-name${who.linked ? '' : ' is-fb'}">${esc(who.name)}</span><span class="mtray-time">${esc(timeLabel(arrived, now))}</span></div>
        <div class="mtray-preview">${esc(previewText(st.latest[t.id]))}</div>
        <span class="mtray-win ${winCls}">${esc(w.text)}${fresh ? ' · no reply yet' : ''}</span>
      </button>`;
  }

  function drawList() {
    const html = listHtml();
    if (html !== st.listShown || body.dataset.thread) { body.innerHTML = html; st.listShown = html; }
    st.listDirty = false;
  }

  // Keyboard focus on a row (or anything in the list) holds a background redraw.
  function listFocusHeld() {
    const a = document.activeElement;
    if (!a || a === body || !body.contains(a)) return { inList: false, visible: false };
    let visible = true;
    try { visible = a.matches(':focus-visible'); } catch (e) { visible = true; }
    return { inList: true, visible };
  }

  // "Can't reply anymore" — waiting threads whose 24 h window closed. Collapsed; not counted.
  function staleHtml() {
    if (!st.stale.length) return '';
    const now = Date.now();
    const rows = !st.showStale ? '' : st.stale.map((t) => {
      const who = threadName(t, st.customers);
      const call = callLink(t, linkedCustomer(t));
      const busy = st.busy === 'done:' + t.id;
      return `<div class="mtray-stale-row">
        <button type="button" class="mtray-stale-open" data-thread="${esc(t.id)}">
          <span class="mtray-row-top"><span class="mtray-name${who.linked ? '' : ' is-fb'}">${esc(who.name)}</span><span class="mtray-time">${esc(timeLabel(t.last_message_at, now))}</span></span>
          <span class="mtray-preview">${esc(previewText(st.latest[t.id]))}</span>
        </button>
        <div class="mtray-stale-acts">
          ${call ? `<a class="mtray-iconbtn" href="${esc(call.tel)}">📞 Call them</a>` : '<span class="mtray-stale-nophone">No phone on file</span>'}
          <button type="button" class="mtray-iconbtn is-done" data-act="done-thread" data-thread-id="${esc(t.id)}"${busy ? ' disabled' : ''}>${busy ? 'Done…' : '✓ Done'}</button>
        </div>
      </div>`;
    }).join('');
    return `<button type="button" class="mtray-stale-toggle" data-act="stale-toggle" aria-expanded="${st.showStale}">Can't reply anymore (${st.stale.length}) ${st.showStale ? '▾' : '▸'}</button>
      ${st.headErr && !st.openThreadId ? `<div class="mtray-head-err">${esc(st.headErr)}</div>` : ''}${rows}`;
  }

  function openThread() { return st.threads.find((x) => x.id === st.openThreadId) || null; }
  function linkedCustomer(t) { return t && t.customer_id ? st.customers[t.customer_id] || null : null; }

  function drawThread() {
    const t = openThread();
    if (!t) { st.openThreadId = null; drawList(); return; }
    const who = threadName(t, st.customers);
    const w = windowLabel(t.last_inbound_at);
    const winCls = !w.open ? 'is-closed' : (w.urgent ? 'is-urgent' : '');
    const viewer = me();
    const cust = linkedCustomer(t);
    const busy = st.busy;

    let actions;
    if (st.confirmUnlink && t.customer_id) {
      actions = `<div class="mtray-confirm">Unlink from ${esc(who.name)}?
        <button type="button" class="mtray-iconbtn is-danger" data-act="unlink-yes"${busy ? ' disabled' : ''}>Yes, unlink</button>
        <button type="button" class="mtray-iconbtn" data-act="unlink-no">Cancel</button></div>`;
    } else {
      actions = `<div class="mtray-actions">
        ${t.customer_id
          ? `<button type="button" class="mtray-link-small" data-act="unlink"${busy ? ' disabled' : ''}>Unlink</button>`
          : `<button type="button" class="mtray-iconbtn" data-act="link"${busy ? ' disabled' : ''}>${busy === 'link' ? 'Linking…' : 'Link to customer'}</button>`}
        <button type="button" class="mtray-iconbtn is-done" data-act="done"${busy ? ' disabled' : ''}>${busy === 'done' ? 'Done…' : '✓ Done'}</button>
      </div>`;
    }

    const msgs = st.threadMsgs.map((m) => {
      const out = m.direction === 'out';
      const failed = m.send_status === 'failed';
      const cls = ['mtray-msg', out ? 'is-out' : 'is-in', m.source === 'page_inbox' ? 'is-inbox' : '', failed ? 'is-failed' : ''].join(' ');
      const atts = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => {
        const u = safeUrl(a && a.url);
        const label = esc(attachmentLabel(a));
        return `<span class="mtray-att">${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label} — view</a>` : label}</span>`;
      }).join('');
      const text = typeof m.text === 'string' && m.text ? esc(m.text) : '';
      const byline = bylineWithViewer(m, st.employees || {}, viewer);
      const when = m.sent_at ? new Date(m.sent_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '';
      // The after-hours auto-reply gets a small "auto" label — the advisor can see
      // exactly what the customer was already told (meta-webhook.md §12).
      const autoTag = m.auto ? '<span class="mtray-auto" title="Sent automatically after hours">auto</span> ' : '';
      return `<div class="${cls}${m.auto ? ' is-auto' : ''}">
        <div class="mtray-bubble">${text}${atts}</div>
        ${failed ? `<div class="mtray-failed">Not sent — ${esc(m.send_error || 'Facebook refused it')}</div>` : ''}
        <div class="mtray-meta">${autoTag}${esc([byline, when].filter(Boolean).join(' · '))}</div>
      </div>`;
    }).join('');

    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const wasThread = body.dataset.thread === t.id;
    titleSmall.textContent = '';
    body.dataset.thread = t.id;
    body.innerHTML = `
      <div class="mtray-thread-head">
        <button type="button" class="mtray-iconbtn" data-act="back">‹ All messages</button>
        <div class="mtray-thread-name">${esc(who.name)}${cust && (cust.phone_primary || cust.phone_secondary) ? ` <span class="mtray-thread-phone">${esc(fmtPhone(cust.phone_primary || cust.phone_secondary))}</span>` : ''}</div>
        ${t.detected_phone && !(cust && (cust.phone_primary || cust.phone_secondary)) ? `<div class="mtray-typed-phone">📞 ${esc(fmtPhone(t.detected_phone))} <small>from their message</small></div>` : ''}
        <span class="mtray-win ${winCls}">${esc(w.text)}</span>
        ${suggestHtml(t)}
        ${actions}
        ${st.headErr ? `<div class="mtray-head-err">${esc(st.headErr)}</div>` : ''}
      </div>
      <div class="mtray-msgs">${msgs || '<div class="mtray-note">Loading…</div>'}</div>`;
    if (!wasThread || atBottom) body.scrollTop = body.scrollHeight;
    drawCompose(t, cust);
  }

  // A phone the customer TYPED that matches exactly one customer → the same
  // one-tap suggestion the call log offers ("Attach to <name>"). Never automatic:
  // the tap runs the tray's normal Link (api/messenger → link). Same customer
  // list the Link picker uses (window.cdFetchAllCustomers — archived excluded).
  function suggestHtml(t) {
    if (!t || t.customer_id || !t.detected_phone || st.busy) return '';
    if (!st.allCustomers) { loadMatchList(); return ''; }
    const c = matchPhoneToCustomer(st.allCustomers, t.detected_phone);
    if (!c) return '';
    st.suggest = { threadId: t.id, customer: c };
    const nm = esc(c.business_name || c.name || 'customer');
    return `<div class="mtray-suggest">This number belongs to <b>${nm}</b>.
      <button type="button" class="mtray-iconbtn" data-act="attach-suggest">Attach to ${nm}</button></div>`;
  }
  let matchLoading = false;
  async function loadMatchList() {
    if (matchLoading || typeof window.cdFetchAllCustomers !== 'function') return;
    matchLoading = true;
    try {
      const rows = await window.cdFetchAllCustomers();
      if (Array.isArray(rows) && rows.length && !st.allCustomers) { st.allCustomers = rows; draw(); }
    } catch (e) { console.warn('[MessengerTray] customer list for phone match failed', e); }
    matchLoading = false;
  }

  // The reply box: never re-created, only toggled — so a refresh can't eat a draft.
  function drawCompose(t, cust) {
    compose.hidden = false;
    const cs = composeState(t, cust);
    composeClosed.hidden = cs.canReply;
    composeClosed.innerHTML = cs.canReply ? '' :
      `${esc(cs.reason)}${cs.tel ? ` <a class="mtray-call" href="${esc(cs.tel)}">📞 Call ${esc(fmtPhone(cust.phone_primary || cust.phone_secondary))}</a>` : ''}`;
    input.disabled = !cs.canReply;
    sendBtn.disabled = !cs.canReply || st.sending;
    sendBtn.textContent = st.sending ? 'Sending…' : 'Send';
    composeErr.hidden = !st.composeErrText;
    composeErr.textContent = st.composeErrText ? `Not sent — ${st.composeErrText}` : '';
    if (input.dataset.thread !== t.id) {           // switched conversation → load its draft
      input.dataset.thread = t.id;
      input.value = st.drafts[t.id] || '';
    }
  }

  // THE draw path. background = a refresh nobody tapped for (the Facebook load,
  // realtime, the 5 s call tick): the list then waits while a row has keyboard focus.
  function draw({ background = false } = {}) {
    drawStrip();
    drawBanner();
    const nWait = waitingCount({ mode: st.mode, fbActive: st.waiting.length, calls: calls() });
    titleSmall.textContent = nWait ? `· ${nWait} waiting` : '';
    // An open Facebook conversation replaces the list in the body (the ringing glance
    // stays pinned above); an opened call takes the whole tray (CSS: has-call-detail).
    root.classList.toggle('has-thread', !!(st.openThreadId && st.mode !== 'signin' && st.mode !== 'notstaff'));
    root.classList.toggle('has-call-detail', !!(callSlot && callSlot.inDetail()));
    if (st.openThreadId && st.mode !== 'signin' && st.mode !== 'notstaff') { st.listShown = ''; drawThread(); return; }
    compose.hidden = true;
    const f = listFocusHeld();
    if (deferListRedraw({ background, focusInList: f.inList, focusVisible: f.visible })) { st.listDirty = true; return; }
    drawList();
    body.dataset.thread = '';
  }
  // A redraw that waited runs as soon as keyboard focus leaves the list.
  body.addEventListener('focusout', () => setTimeout(() => {
    if (st.listDirty && !listFocusHeld().inList) draw();
  }, 0));

  /* ── what to show after a load ───────────────────────────────────────── */
  // Rules: uiAfterLoad (shared/inbox-list-logic.js) — never opens on the first load,
  // opens for a newly arrived message, folds when the last waiting item is handled.
  function decideUi(prevNewest) {
    const count = waitingCount({ mode: st.mode, fbActive: st.waiting.length, calls: calls() });
    const before = st.lastCount;
    st.lastCount = count;
    const next = uiAfterLoad({
      mode: st.mode, loadedOnce: st.loadedOnce, loadedOnceBefore: st.loadedOnceBefore, ui: st.ui, count, before,
      newInbound: hasNewInbound(prevNewest, st.newest) && !!st.waiting.length,
      threadOpen: !!st.openThreadId, staleOpen: st.showStale,
    });
    if (next) setUi(next);
  }

  /* ── loading ─────────────────────────────────────────────────────────── */
  let loading = null, again = false;
  async function load() {
    if (loading) { again = true; return loading; }
    loading = (async () => {
      const prevNewest = st.newest;
      st.loadedOnceBefore = st.loadedOnce;
      try {
        const sess = await db.auth.getSession();
        const session = sess && sess.data && sess.data.session;
        if (!session) { st.mode = 'signin'; return; }

        if (!st.staffChecked) {
          const r = await db.rpc('is_staff');
          if (r.error) throw r.error;
          st.staffChecked = true;
          if (r.data !== true) { st.mode = 'notstaff'; return; }
          subscribe(session.access_token);
        }

        const tr = await db.from('social_threads')
          .select('id, channel, psid, display_name, customer_id, last_inbound_at, last_inbound_received_at, last_message_at, done_at, detected_phone')
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(200);
        if (tr.error) throw tr.error;
        st.threads = tr.data || [];
        ({ active: st.waiting, stale: st.stale } = splitWaiting(st.threads));
        const ids = [...st.waiting, ...st.stale].map((t) => t.id);

        const custIds = [...new Set(st.threads.map((t) => t.customer_id).filter(Boolean))].filter((id) => !st.customers[id]);
        if (custIds.length) {
          const cr = await db.from('customers').select('id, name, phone_primary, phone_secondary').in('id', custIds);
          if (!cr.error) for (const c of cr.data || []) st.customers[c.id] = c;
        }

        if (ids.length) {
          const mr = await db.from('social_messages')
            .select('id, thread_id, direction, source, text, attachments, send_status, sent_at, auto')
            .in('thread_id', ids).order('sent_at', { ascending: false }).limit(500);
          if (mr.error) throw mr.error;
          st.latest = latestByThread(mr.data);
          st.lastStaff = lastStaffReplyByThread(mr.data);
        } else {
          st.latest = {};
          st.lastStaff = {};
        }

        if (st.openThreadId) await loadThread(st.openThreadId);
        st.newest = newestInbound(st.threads);
        st.mode = 'ok';
        st.loadedOnce = true;
      } catch (e) {
        st.mode = 'error';
        st.errorText = (e && e.message) ? String(e.message).slice(0, 160) : 'network error';
        console.warn('[MessengerTray] load failed', e);
      } finally {
        decideUi(prevNewest);
        draw({ background: true });
      }
    })();
    try { await loading; } finally {
      loading = null;
      if (again) { again = false; load(); }
    }
  }

  async function loadEmployees() {
    if (st.employees) return;
    const r = await db.from('employees_visible').select('id, name');
    st.employees = {};
    if (!r.error) for (const e of r.data || []) st.employees[e.id] = e;
  }

  async function loadThread(id) {
    await loadEmployees();
    const r = await db.from('social_messages')
      .select('id, thread_id, direction, source, text, attachments, send_status, send_error, sent_by, sent_at, auto')
      .eq('thread_id', id).order('sent_at', { ascending: true }).limit(500);
    if (r.error) throw r.error;
    if (st.openThreadId === id) st.threadMsgs = r.data || [];
  }

  /* ── actions ─────────────────────────────────────────────────────────── */
  async function send() {
    const t = openThread();
    if (!t || st.sending) return;
    const text = input.value.trim();
    if (!text) return;
    if (!composeState(t, linkedCustomer(t)).canReply) return;
    st.sending = true;
    st.composeErrText = '';
    drawCompose(t, linkedCustomer(t));
    const r = await callApi({ action: 'reply', thread_id: t.id, text });
    st.sending = false;
    if (r.ok) {
      if (input.dataset.thread === t.id) input.value = '';
      delete st.drafts[t.id];
      st.bannerText = '';
    } else {
      const e = replyError(r.status, r.body);      // text stays in the box
      st.composeErrText = e.message;
      if (e.banner) st.bannerText = "Facebook isn't connected — tell Cris. " + e.message;
    }
    try { await loadThread(t.id); } catch (e) {}   // shows the sent (or red failed) message now
    draw();
    load();
  }

  // Done on the open conversation, or (from "Can't reply anymore") on thread `id`.
  async function doDone(id) {
    const t = id ? st.threads.find((x) => x.id === id) : openThread();
    if (!t || st.busy) return;
    st.busy = id ? 'done:' + id : 'done'; st.headErr = ''; draw();
    const r = await callApi({ action: 'done', thread_id: t.id });
    st.busy = null;
    if (!r.ok) { st.headErr = replyError(r.status, r.body).message; draw(); return; }
    // Leave the conversation; the list redraws without it.
    t.done_at = (r.body && r.body.thread && r.body.thread.done_at) || new Date().toISOString();
    ({ active: st.waiting, stale: st.stale } = splitWaiting(st.threads));
    if (!id) { st.openThreadId = null; st.threadMsgs = []; st.confirmUnlink = false; }
    if (!st.stale.length) st.showStale = false;
    if (!st.waiting.length && !calls() && !st.showStale) setUi('tucked');
    draw();
    load();
  }

  async function doLink(customer) {
    const t = openThread();
    if (!t || st.busy) return;
    st.busy = 'link'; st.headErr = ''; draw();
    const r = await callApi({ action: 'link', thread_id: t.id, customer_id: customer.id });
    st.busy = null;
    if (!r.ok) { st.headErr = replyError(r.status, r.body).message; draw(); return; }
    st.customers[customer.id] = { id: customer.id, name: (r.body && r.body.customer && r.body.customer.name) || customer.name,
      phone_primary: customer.phone_primary || null, phone_secondary: customer.phone_secondary || null };
    t.customer_id = customer.id;
    draw();
    load();
  }

  async function doUnlink() {
    const t = openThread();
    if (!t || st.busy) return;
    st.busy = 'unlink'; st.headErr = ''; draw();
    const r = await callApi({ action: 'link', thread_id: t.id, customer_id: null });
    st.busy = null;
    st.confirmUnlink = false;
    if (!r.ok) { st.headErr = replyError(r.status, r.body).message; draw(); return; }
    t.customer_id = null;
    draw();
    load();
  }

  /* ── the customer picker (same list + search rules as the Desk's) ────── */
  async function openPicker() {
    picker.hidden = false;
    pickerSearch.value = '';
    pickerErr.hidden = true;
    pickerList.innerHTML = '<div class="mtray-note">Loading customers…</div>';
    pickerSearch.focus();
    if (!st.allCustomers) {
      st.allCustomers = typeof window.cdFetchAllCustomers === 'function' ? await window.cdFetchAllCustomers() : [];
      if (!st.allCustomers.length && window.cdCustFetchError) {
        pickerErr.hidden = false;
        pickerErr.textContent = `Couldn't load customers: ${window.cdCustFetchError}`;
        st.allCustomers = null;
      }
    }
    renderPicker();
  }
  function closePicker() { picker.hidden = true; }
  function renderPicker() {
    const rows = searchCustomers(st.allCustomers || [], pickerSearch.value);
    pickerList.innerHTML = rows.length ? rows.map((c) =>
      `<button type="button" class="desk-attach-item mtray-pick" data-cust-id="${esc(c.id)}">` +
      `<span class="desk-attach-name">${esc(c.business_name || c.name || '(no name)')}</span>` +
      `<span class="desk-attach-phone">${esc(fmtPhone(c.phone_primary))}</span></button>`
    ).join('') : `<div class="mtray-note">${st.allCustomers ? 'No matches.' : ''}</div>`;
  }
  pickerSearch.addEventListener('input', renderPicker);

  /* ── realtime + catch-up ─────────────────────────────────────────────── */
  let channel = null, debounce = null;
  function schedule() { clearTimeout(debounce); debounce = setTimeout(load, 300); }
  function subscribe(token) {
    if (channel) return;
    try { if (token && db.realtime && db.realtime.setAuth) db.realtime.setAuth(token); } catch (e) {}
    channel = db.channel('advisor-board-messenger-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'social_threads' }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'social_messages' }, schedule)
      .subscribe((status) => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('[MessengerTray] realtime', status); });
  }
  setInterval(load, CATCH_UP_MS);

  /* ── events ──────────────────────────────────────────────────────────── */
  strip.addEventListener('click', () => { setUi('open'); draw(); });
  input.addEventListener('input', () => { if (input.dataset.thread) st.drafts[input.dataset.thread] = input.value; });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
  });

  root.addEventListener('click', async (ev) => {
    const callRow = ev.target.closest('[data-call-row]');
    if (callRow && body.contains(callRow)) { callSlot.open(callRow.dataset.callRow); return; }
    const pick = ev.target.closest('[data-cust-id]');
    if (pick) {
      const c = (st.allCustomers || []).find((x) => String(x.id) === pick.dataset.custId);
      closePicker();
      if (c) doLink(c);
      return;
    }
    const act = ev.target.closest('[data-act]');
    if (act) {
      switch (act.dataset.act) {
        case 'tuck':
          st.openThreadId = null; st.confirmUnlink = false; st.showStale = false;
          setUi('tucked');
          draw(); return;
        case 'back':
          st.openThreadId = null; st.threadMsgs = []; st.confirmUnlink = false; st.headErr = ''; st.composeErrText = '';
          closePicker();
          if (st.mode === 'ok' && !st.waiting.length && !calls()) setUi('tucked');
          draw(); return;
        case 'send': send(); return;
        case 'done': doDone(); return;
        case 'done-thread': doDone(act.dataset.threadId); return;
        case 'stale-toggle': st.showStale = !st.showStale; draw(); return;
        case 'link': openPicker(); return;
        case 'picker-close': closePicker(); return;
        case 'unlink': st.confirmUnlink = true; draw(); return;
        case 'unlink-no': st.confirmUnlink = false; draw(); return;
        case 'unlink-yes': doUnlink(); return;
        case 'attach-suggest': {
          const t = openThread();
          if (t && st.suggest && st.suggest.threadId === t.id) doLink(st.suggest.customer);
          return;
        }
        default: return;
      }
    }
    const row = ev.target.closest('[data-thread]');
    if (row && (row.classList.contains('mtray-row') || row.classList.contains('mtray-stale-open'))) {
      st.openThreadId = row.dataset.thread;
      st.threadMsgs = []; st.confirmUnlink = false; st.headErr = ''; st.composeErrText = '';
      draw();
      try { await loadThread(st.openThreadId); } catch (e) { console.warn('[MessengerTray] thread load failed', e); }
      draw();
      if (!input.disabled) input.focus();
    }
  });

  /* ── incoming calls (slice 1) ────────────────────────────────────────── */
  // The calls area. A new call opens the tray (from hidden or tucked); the last
  // call closing hides it again when nothing else waits.
  callSlot = mountCallSlot({
    section: callSection,
    timeLabel,
    // Rules: uiAfterCallChange — only a call ringing NOW opens the tray; the last call
    // going away folds it when nothing else waits. user = a tap (open / ‹ All), drawn at once.
    onChange({ added, ringing, user }) {
      const next = uiAfterCallChange({
        added, ringing, calls: calls(), ui: st.ui, threadOpen: !!st.openThreadId,
        staleOpen: st.showStale, mode: st.mode, fbWaiting: st.waiting.length,
      });
      if (next) setUi(next);
      draw({ background: !user });
    },
  });
  function calls() { return callSlot ? callSlot.count() : 0; }
  // Hand-off from the callerCard code (a classic script that runs before this module).
  window.cdCallInbox = { add: (card) => callSlot.add(card), has: (id) => callSlot.has(id) };
  const pending = Array.isArray(window.cdCallInboxPending) ? window.cdCallInboxPending.splice(0) : [];
  for (const card of pending) if (!card._closed) callSlot.add(card);

  load();
  return { reload: load };
}
