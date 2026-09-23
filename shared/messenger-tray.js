/* ============================================================
   messenger-tray.js — the Advisor inbox tray (Messenger steps 4 + 5).
   Wiring: docs/wiring/messenger-tray.md. Rules: shared/messenger-tray-logic.js.

   Mounted ONCE by advisor-board.html, on <body>, outside every view — so it
   shows on every advisor tab. READS social_threads / social_messages with the
   signed-in Supabase session (staff_read policy: is_staff()). Every WRITE —
   reply, link / unlink, done — is a POST to /api/messenger through
   cdAuthFetch (the same session as a bearer token); the browser never writes
   a social_* row itself. No anon fallback.

   States:
     hidden  — signed-in staff, nothing waiting.
     open    — the panel (list, or one conversation + its reply box).
     tucked  — a thin strip on the right edge: FB badge + count. Click → open.
     signin / notstaff / error — the strip with a "!" badge; opening it says why.
   A NEW customer message opens it from tucked. Tucking is remembered per
   browser until the next new customer message.

   The reply box lives OUTSIDE the redrawn area, so a realtime refresh never
   wipes what someone is typing. Drafts are kept per conversation.

   Refresh: realtime on both tables + a 60-second catch-up.
   ============================================================ */
import {
  waitingThreads, threadName, windowLabel, previewText, attachmentLabel,
  timeLabel, newestInbound, hasNewInbound, latestByThread,
  composeState, replyError, searchCustomers, bylineWithViewer,
} from './messenger-tray-logic.js';

const TUCK_KEY = 'cdMtrayTuckedAt';   // newest inbound (ms) when the viewer tucked it
const CATCH_UP_MS = 60 * 1000;
const API = '/api/messenger';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : null;
const fmtPhone = (p) => (typeof window.formatPhone === 'function' ? window.formatPhone(p) : p) || '';

function readTuck() { try { const v = localStorage.getItem(TUCK_KEY); return v == null ? null : Number(v); } catch (e) { return null; } }
function writeTuck(v) { try { if (v == null) localStorage.removeItem(TUCK_KEY); else localStorage.setItem(TUCK_KEY, String(v)); } catch (e) {} }

export function mountMessengerTray({ db, viewer }) {
  if (!db || document.getElementById('mtray')) return;
  const me = () => { try { return (typeof viewer === 'function' && viewer()) || null; } catch (e) { return null; } };

  const root = document.createElement('div');
  root.id = 'mtray';
  root.className = 'mtray';
  root.innerHTML = `
    <button type="button" class="mtray-strip" aria-label="Open Facebook messages">
      <span class="mtray-fb" aria-hidden="true">f</span><span class="mtray-count"></span>
    </button>
    <aside class="mtray-panel" aria-label="Facebook messages">
      <div class="mtray-head">
        <div class="mtray-title">Facebook messages<small></small></div>
        <button type="button" class="mtray-iconbtn" data-act="tuck" title="Tuck the tray away">Hide »</button>
      </div>
      <div class="mtray-banner" hidden></div>
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

  const st = {
    mode: 'loading',           // loading | ok | signin | notstaff | error
    ui: 'hidden',              // hidden | open | tucked
    threads: [], waiting: [], latest: {}, customers: {}, employees: null,
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
    if (ui !== 'open') closePicker();
  }

  function drawStrip() {
    if (st.mode === 'ok') {
      countEl.textContent = String(st.waiting.length);
      countEl.classList.remove('is-note');
      strip.title = `${st.waiting.length} Facebook conversation${st.waiting.length === 1 ? '' : 's'} waiting`;
    } else {
      countEl.textContent = '!';
      countEl.classList.add('is-note');
      strip.title = 'Facebook messages — sign in from CrisData to see them';
    }
  }

  function drawBanner() {
    banner.hidden = !st.bannerText;
    banner.textContent = st.bannerText ? `⚠ ${st.bannerText}` : '';
  }

  function drawList() {
    compose.hidden = true;
    titleSmall.textContent = st.mode === 'ok' ? `· ${st.waiting.length} waiting` : '';
    if (st.mode === 'signin') {
      body.innerHTML = `<div class="mtray-note"><strong>Sign in from CrisData to see Facebook messages.</strong>This board was opened without a CrisData sign-in, so it can't read the shop's Facebook conversations. Log out and sign in again from the CrisData front door.</div>`;
      return;
    }
    if (st.mode === 'notstaff') {
      body.innerHTML = `<div class="mtray-note"><strong>This sign-in can't see Facebook messages.</strong>Only active CrisData employees can. Ask Cris to check your login.</div>`;
      return;
    }
    if (st.mode === 'error' && !st.loadedOnce) {
      body.innerHTML = `<div class="mtray-note"><strong>Couldn't load Facebook messages.</strong>${esc(st.errorText)} — it will try again within a minute.</div>`;
      return;
    }
    const warn = st.mode === 'error' ? `<div class="mtray-warn">Couldn't refresh just now — showing what was last loaded.</div>` : '';
    if (!st.waiting.length) {
      body.innerHTML = warn + `<div class="mtray-note"><strong>All caught up.</strong>New Facebook messages will show here.</div>`;
      return;
    }
    const now = Date.now();
    body.innerHTML = warn + st.waiting.map((t) => {
      const who = threadName(t, st.customers);
      const w = windowLabel(t.last_inbound_at, now);
      const winCls = !w.open ? 'is-closed' : (w.urgent ? 'is-urgent' : '');
      return `<button type="button" class="mtray-row" data-thread="${esc(t.id)}">
        <div class="mtray-row-top"><span class="mtray-name${who.linked ? '' : ' is-fb'}">${esc(who.name)}</span><span class="mtray-time">${esc(timeLabel(t.last_message_at, now))}</span></div>
        <div class="mtray-preview">${esc(previewText(st.latest[t.id]))}</div>
        <span class="mtray-win ${winCls}">${esc(w.text)}</span>
      </button>`;
    }).join('');
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
      return `<div class="${cls}">
        <div class="mtray-bubble">${text}${atts}</div>
        ${failed ? `<div class="mtray-failed">Not sent — ${esc(m.send_error || 'Facebook refused it')}</div>` : ''}
        <div class="mtray-meta">${esc([byline, when].filter(Boolean).join(' · '))}</div>
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
        <span class="mtray-win ${winCls}">${esc(w.text)}</span>
        ${actions}
        ${st.headErr ? `<div class="mtray-head-err">${esc(st.headErr)}</div>` : ''}
      </div>
      <div class="mtray-msgs">${msgs || '<div class="mtray-note">Loading…</div>'}</div>`;
    if (!wasThread || atBottom) body.scrollTop = body.scrollHeight;
    drawCompose(t, cust);
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

  function draw() {
    drawStrip();
    drawBanner();
    if (st.openThreadId && st.mode !== 'signin' && st.mode !== 'notstaff') drawThread();
    else { body.dataset.thread = ''; drawList(); }
  }

  /* ── what to show after a load ───────────────────────────────────────── */
  function decideUi(prevNewest) {
    if (st.mode === 'signin' || st.mode === 'notstaff' || (st.mode === 'error' && !st.loadedOnce)) {
      if (st.ui === 'hidden') setUi('tucked');
      return;
    }
    if (!st.waiting.length) {
      if (!(st.ui === 'open' && st.openThreadId)) setUi('hidden');
      return;
    }
    if (!st.loadedOnceBefore) {
      const tuck = readTuck();
      setUi(tuck != null && st.newest != null && st.newest <= tuck ? 'tucked' : 'open');
      if (st.ui === 'open') writeTuck(null);
      return;
    }
    if (hasNewInbound(prevNewest, st.newest)) { setUi('open'); writeTuck(null); return; }
    if (st.ui === 'hidden') setUi('tucked');
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
          .select('id, channel, psid, display_name, customer_id, last_inbound_at, last_message_at, done_at')
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(200);
        if (tr.error) throw tr.error;
        st.threads = tr.data || [];
        st.waiting = waitingThreads(st.threads);
        const ids = st.waiting.map((t) => t.id);

        const custIds = [...new Set(st.threads.map((t) => t.customer_id).filter(Boolean))].filter((id) => !st.customers[id]);
        if (custIds.length) {
          const cr = await db.from('customers').select('id, name, phone_primary, phone_secondary').in('id', custIds);
          if (!cr.error) for (const c of cr.data || []) st.customers[c.id] = c;
        }

        if (ids.length) {
          const mr = await db.from('social_messages')
            .select('id, thread_id, direction, source, text, attachments, send_status, sent_at')
            .in('thread_id', ids).order('sent_at', { ascending: false }).limit(500);
          if (mr.error) throw mr.error;
          st.latest = latestByThread(mr.data);
        } else {
          st.latest = {};
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
        draw();
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
      .select('id, thread_id, direction, source, text, attachments, send_status, send_error, sent_by, sent_at')
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

  async function doDone() {
    const t = openThread();
    if (!t || st.busy) return;
    st.busy = 'done'; st.headErr = ''; draw();
    const r = await callApi({ action: 'done', thread_id: t.id });
    st.busy = null;
    if (!r.ok) { st.headErr = replyError(r.status, r.body).message; draw(); return; }
    // Leave the conversation; the list redraws without it. Nothing left → hide.
    t.done_at = (r.body && r.body.thread && r.body.thread.done_at) || new Date().toISOString();
    st.waiting = waitingThreads(st.threads);
    st.openThreadId = null; st.threadMsgs = []; st.confirmUnlink = false;
    if (!st.waiting.length) setUi('hidden');
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
  strip.addEventListener('click', () => { setUi('open'); writeTuck(null); draw(); });
  input.addEventListener('input', () => { if (input.dataset.thread) st.drafts[input.dataset.thread] = input.value; });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
  });

  root.addEventListener('click', async (ev) => {
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
          writeTuck(st.newest != null ? st.newest : Date.now());
          st.openThreadId = null; st.confirmUnlink = false;
          setUi(st.mode === 'ok' && !st.waiting.length ? 'hidden' : 'tucked');
          draw(); return;
        case 'back':
          st.openThreadId = null; st.threadMsgs = []; st.confirmUnlink = false; st.headErr = ''; st.composeErrText = '';
          closePicker();
          if (st.mode === 'ok' && !st.waiting.length) setUi('hidden');
          draw(); return;
        case 'send': send(); return;
        case 'done': doDone(); return;
        case 'link': openPicker(); return;
        case 'picker-close': closePicker(); return;
        case 'unlink': st.confirmUnlink = true; draw(); return;
        case 'unlink-no': st.confirmUnlink = false; draw(); return;
        case 'unlink-yes': doUnlink(); return;
        default: return;
      }
    }
    const row = ev.target.closest('[data-thread]');
    if (row && row.classList.contains('mtray-row')) {
      st.openThreadId = row.dataset.thread;
      st.threadMsgs = []; st.confirmUnlink = false; st.headErr = ''; st.composeErrText = '';
      draw();
      try { await loadThread(st.openThreadId); } catch (e) { console.warn('[MessengerTray] thread load failed', e); }
      draw();
      if (!input.disabled) input.focus();
    }
  });

  load();
  return { reload: load };
}
