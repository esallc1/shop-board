/* ============================================================
   messenger-tray.js — the Advisor inbox tray, READ-ONLY (Messenger step 4).
   Wiring: docs/wiring/messenger-tray.md. Rules: shared/messenger-tray-logic.js.

   Mounted ONCE by advisor-board.html, on <body>, outside every view — so it
   shows on every advisor tab. It only READS social_threads / social_messages,
   with the signed-in Supabase session (the staff_read policy: is_staff()).
   There is no anon fallback and no write of any kind from here — replying,
   linking and Done arrive in step 5 through api/messenger.js.

   States:
     hidden  — signed-in staff, nothing waiting.
     open    — the panel (list, or one thread).
     tucked  — a thin strip on the right edge: FB badge + count. Click → open.
     signin / notstaff / error — the strip with a "!" badge; opening it says why.
               Never an empty-looking tray.
   A NEW customer message opens it from tucked. Tucking is remembered per
   browser until the next new customer message.

   Refresh: realtime on both tables (runs as the signed-in user, so RLS
   applies) + a 60-second catch-up for a dropped socket.
   ============================================================ */
import {
  waitingThreads, threadName, windowLabel, previewText, attachmentLabel,
  messageByline, timeLabel, newestInbound, hasNewInbound, latestByThread,
} from './messenger-tray-logic.js';

const TUCK_KEY = 'cdMtrayTuckedAt';   // newest inbound (ms) when the viewer tucked it
const CATCH_UP_MS = 60 * 1000;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : null;

function readTuck() { try { const v = localStorage.getItem(TUCK_KEY); return v == null ? null : Number(v); } catch (e) { return null; } }
function writeTuck(v) { try { if (v == null) localStorage.removeItem(TUCK_KEY); else localStorage.setItem(TUCK_KEY, String(v)); } catch (e) {} }

export function mountMessengerTray({ db }) {
  if (!db || document.getElementById('mtray')) return;

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
      <div class="mtray-body"></div>
      <div class="mtray-foot">Read-only for now — reply, link and Done come next. Reply in the Facebook app meanwhile.</div>
    </aside>`;
  document.body.appendChild(root);
  const strip = root.querySelector('.mtray-strip');
  const countEl = root.querySelector('.mtray-count');
  const titleSmall = root.querySelector('.mtray-title small');
  const body = root.querySelector('.mtray-body');

  const st = {
    mode: 'loading',           // loading | ok | signin | notstaff | error
    ui: 'hidden',              // hidden | open | tucked
    threads: [], waiting: [], latest: {}, customers: {}, employees: null,
    openThreadId: null, threadMsgs: [], newest: null, loadedOnce: false,
    errorText: '', staffChecked: false,
  };

  /* ── drawing ─────────────────────────────────────────────────────────── */
  function setUi(ui) {
    st.ui = ui;
    root.classList.toggle('is-open', ui === 'open');
    root.classList.toggle('is-tucked', ui === 'tucked');
    document.body.classList.toggle('mtray-open', ui === 'open');
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

  function drawList() {
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

  function drawThread() {
    const t = st.threads.find((x) => x.id === st.openThreadId);
    if (!t) { st.openThreadId = null; drawList(); return; }
    const who = threadName(t, st.customers);
    const w = windowLabel(t.last_inbound_at);
    const winCls = !w.open ? 'is-closed' : (w.urgent ? 'is-urgent' : '');
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
      const byline = messageByline(m, st.employees || {});
      const when = m.sent_at ? new Date(m.sent_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '';
      return `<div class="${cls}">
        <div class="mtray-bubble">${text}${atts}</div>
        ${failed ? `<div class="mtray-failed">Not sent — ${esc(m.send_error || 'Facebook refused it')}</div>` : ''}
        <div class="mtray-meta">${esc([byline, when].filter(Boolean).join(' · '))}</div>
      </div>`;
    }).join('');
    titleSmall.textContent = '';
    body.innerHTML = `
      <div class="mtray-thread-head">
        <button type="button" class="mtray-iconbtn" data-act="back">‹ All messages</button>
        <div class="mtray-thread-name" style="margin-top:8px">${esc(who.name)}</div>
        <span class="mtray-win ${winCls}">${esc(w.text)}</span>
      </div>
      <div class="mtray-msgs">${msgs || '<div class="mtray-note">Loading…</div>'}</div>`;
    body.scrollTop = body.scrollHeight;
  }

  function draw() {
    drawStrip();
    if (st.openThreadId && st.mode !== 'signin' && st.mode !== 'notstaff') drawThread(); else drawList();
  }

  /* ── what to show after a load ───────────────────────────────────────── */
  function decideUi(prevNewest) {
    if (st.mode === 'signin' || st.mode === 'notstaff' || (st.mode === 'error' && !st.loadedOnce)) {
      if (st.ui === 'hidden') setUi('tucked');
      return;
    }
    if (!st.waiting.length) {
      // Nothing waiting: hide — unless the viewer is reading a thread right now.
      if (!(st.ui === 'open' && st.openThreadId)) setUi('hidden');
      return;
    }
    if (!st.loadedOnceBefore) {
      // First load: open, unless they tucked it and nothing newer has arrived since.
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
          const cr = await db.from('customers').select('id, name').in('id', custIds);
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
  root.addEventListener('click', async (ev) => {
    const act = ev.target.closest('[data-act]');
    if (act && act.dataset.act === 'tuck') {
      writeTuck(st.newest != null ? st.newest : Date.now());
      setUi(st.mode === 'ok' && !st.waiting.length ? 'hidden' : 'tucked');
      st.openThreadId = null;
      draw();
      return;
    }
    if (act && act.dataset.act === 'back') { st.openThreadId = null; st.threadMsgs = []; draw(); if (!st.waiting.length) { setUi('hidden'); } return; }
    const row = ev.target.closest('[data-thread]');
    if (row) {
      st.openThreadId = row.dataset.thread;
      st.threadMsgs = [];
      draw();
      try { await loadThread(st.openThreadId); } catch (e) { console.warn('[MessengerTray] thread load failed', e); }
      draw();
    }
  });

  load();
  return { reload: load };
}
