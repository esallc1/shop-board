/* ============================================================
   announcement-banner.js — the office Announcement Banner (v1).

   The owner broadcasts ONE short message to the office team; it shows as a
   dismissible banner at the top of the OFFICE boards (advisor + owner). NOT the
   tech-floor screens. The board shows the single most-recent ACTIVE, non-expired
   announcement (rotating carousel is a later phase).

   SELF-CONTAINED (same shape as roadmap.js / file-cabinet.js): injects its own
   namespaced <style> (.anc-*) and exposes window.AnnouncementBanner.init(config).

     AnnouncementBanner.init({
       db,                          // supabase client (anon key)
       bannerMount: '#announce-banner',   // where the banner renders (both boards)
       manageMount: '#announce-manage',   // OWNER only — post/remove panel (omit elsewhere)
       getName: () => CHAT_IDENTITY.name, // poster name
       endpoint: '/api/announcement',     // service-role write endpoint
     });

   SECURITY: reading is anon SELECT. Creating/removing is service-role only, via
   `endpoint` (api/announcement.js) — the board's anon key cannot write this table.

   REALTIME + SELF-HEAL (the calls-channel lesson, encapsulated): the module owns
   its realtime channel AND its own connection-health net — it re-subscribes on
   focus / visibilitychange / a 60s tick if the socket dropped, and refetches. It
   does NOT rely on any board wiring, so the global-channel gap can't recur.

   DISMISS: each device remembers dismissed announcement ids in localStorage, so a
   dismissed banner stays gone for that user but still shows for everyone else
   until they dismiss it or it's removed/expired.
   ============================================================ */

window.AnnouncementBanner = (function () {
  'use strict';

  const DISMISS_KEY = 'crisdata_dismissed_announcements';
  const STYLES = ['normal', 'important'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function isMissingTable(err) {
    return !!err && (err.code === '42P01' || /does not exist|find the table/i.test(err.message || ''));
  }
  function loadDismissed() {
    try { const a = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (_) { return []; }
  }
  function saveDismissed(ids) {
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(ids.slice(-200))); } catch (_) {}   // cap growth
  }

  function injectStyle() {
    if (document.querySelector('style[data-announcement-banner]')) return;
    const st = document.createElement('style');
    st.setAttribute('data-announcement-banner', '');
    st.textContent = `
    .anc-banner { display:flex; align-items:flex-start; gap:10px; border-radius:10px; padding:11px 14px; margin-bottom:14px; font-size:0.88rem; line-height:1.45; border:1px solid; }
    .anc-banner.normal { background:#eef2ff; border-color:#c7d2fe; color:#3730a3; }
    .anc-banner.important { background:#fef2f2; border-color:#fecaca; color:#991b1b; }
    .anc-icon { font-size:1.05rem; line-height:1.3; flex-shrink:0; }
    .anc-body { flex:1; min-width:0; }
    .anc-msg { font-weight:600; overflow-wrap:anywhere; white-space:pre-wrap; }
    .anc-banner.important .anc-msg { font-weight:800; }
    .anc-meta { font-size:0.72rem; opacity:0.75; margin-top:3px; }
    .anc-x { flex-shrink:0; border:none; background:transparent; color:inherit; font-size:1.15rem; line-height:1; cursor:pointer; padding:0 2px; opacity:0.65; }
    .anc-x:hover { opacity:1; }

    .anc-manage { display:flex; flex-direction:column; gap:10px; }
    .anc-input { width:100%; border:1px solid var(--border); border-radius:8px; padding:9px 11px; font:inherit; font-size:0.88rem; color:var(--text); background:var(--surface,#fff); resize:vertical; min-height:60px; }
    .anc-input:focus { outline:none; border-color:var(--accent); }
    .anc-controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .anc-controls select, .anc-controls input[type="date"] { border:1px solid var(--border); border-radius:8px; padding:7px 9px; font:inherit; font-size:0.82rem; color:var(--text); background:var(--surface,#fff); }
    .anc-controls label { font-size:0.78rem; color:var(--muted); display:inline-flex; align-items:center; gap:6px; }
    .anc-audience { display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:0.82rem; color:var(--text); }
    .anc-audience-label { font-weight:800; color:var(--muted); font-size:0.68rem; text-transform:uppercase; letter-spacing:0.5px; }
    .anc-audience label { display:inline-flex; align-items:center; gap:6px; cursor:pointer; font-weight:600; }
    .anc-audience input { accent-color:var(--accent); width:15px; height:15px; cursor:pointer; }
    .anc-post { margin-left:auto; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:8px; padding:8px 16px; font-size:0.84rem; font-weight:800; cursor:pointer; }
    .anc-post:hover { filter:brightness(0.96); }
    .anc-post:disabled { opacity:0.6; cursor:default; }
    .anc-status { font-size:0.8rem; min-height:1em; }
    .anc-status.ok { color:#15803d; } .anc-status.err { color:var(--red); } .anc-status.wait { color:var(--accent); }
    .anc-current { border-top:1px solid var(--border); padding-top:10px; }
    .anc-current-none { color:var(--muted); font-size:0.82rem; }
    .anc-current-row { display:flex; align-items:flex-start; gap:10px; }
    .anc-current-pill { font-size:0.62rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px; padding:2px 7px; border-radius:20px; flex-shrink:0; }
    .anc-current-pill.normal { background:#eef2ff; color:#3730a3; }
    .anc-current-pill.important { background:#fef2f2; color:#991b1b; }
    .anc-current-msg { flex:1; font-size:0.85rem; color:var(--text); overflow-wrap:anywhere; }
    .anc-current-sub { font-size:0.72rem; color:var(--muted); margin-top:2px; }
    .anc-remove { border:1px solid var(--border); background:var(--surface,#fff); color:var(--text); border-radius:7px; padding:4px 11px; font-size:0.76rem; font-weight:700; cursor:pointer; flex-shrink:0; }
    .anc-remove:hover { border-color:var(--red); color:var(--red); }
    `;
    document.head.appendChild(st);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function init(config) {
    injectStyle();
    const db = config.db;
    const endpoint = config.endpoint || '/api/announcement';
    const getName = config.getName || (() => null);
    // role = which office board this is ('manager'|'advisor'|'bookkeeping'). When
    // set, the banner only shows announcements whose audience includes that role.
    // Omitted (owner board) → unfiltered: the most-recent active one, as a
    // broadcaster preview.
    const role = config.role || null;
    const bannerEl = config.bannerMount ? document.querySelector(config.bannerMount) : null;
    const manageEl = config.manageMount ? document.querySelector(config.manageMount) : null;

    let current = null;        // the fetched active announcement (raw), or null
    let channel = null;
    let netWired = false;

    // ── render: banner (dismiss-filtered) ──
    function renderBanner() {
      if (!bannerEl) return;
      const dismissed = loadDismissed();
      if (!current || dismissed.includes(current.id)) { bannerEl.innerHTML = ''; return; }
      const style = STYLES.includes(current.style) ? current.style : 'normal';
      const icon = style === 'important' ? '🚨' : '📣';
      const by = current.posted_by_name ? `Posted by ${esc(current.posted_by_name)}` : '';
      bannerEl.innerHTML =
        `<div class="anc-banner ${style}">` +
          `<span class="anc-icon">${icon}</span>` +
          `<div class="anc-body"><div class="anc-msg">${esc(current.message)}</div>` +
            (by ? `<div class="anc-meta">${by}</div>` : '') +
          `</div>` +
          `<button class="anc-x" title="Dismiss" aria-label="Dismiss">×</button>` +
        `</div>`;
      bannerEl.querySelector('.anc-x').addEventListener('click', () => {
        const d = loadDismissed(); if (!d.includes(current.id)) { d.push(current.id); saveDismissed(d); }
        renderBanner();
      });
    }

    // ── render: manage panel (owner; shows the RAW active one + Remove) ──
    function renderManageCurrent() {
      if (!manageEl) return;
      const box = manageEl.querySelector('.anc-current');
      if (!box) return;
      if (!current) { box.innerHTML = '<div class="anc-current-none">No active announcement.</div>'; return; }
      const style = STYLES.includes(current.style) ? current.style : 'normal';
      const aud = Array.isArray(current.audience) ? current.audience : [];
      const cap = (r) => r.charAt(0).toUpperCase() + r.slice(1);
      const audLabel = (!aud.length || aud.length >= 3) ? 'everyone' : aud.map(cap).join(', ');
      const sub = [`seen by ${audLabel}`,
        current.posted_by_name ? `by ${esc(current.posted_by_name)}` : '',
        current.expires_at ? `hides after ${esc(fmtDate(current.expires_at))}` : ''].filter(Boolean).join(' · ');
      box.innerHTML =
        `<div class="anc-current-row">` +
          `<span class="anc-current-pill ${style}">${style}</span>` +
          `<div style="flex:1"><div class="anc-current-msg">${esc(current.message)}</div>` +
            (sub ? `<div class="anc-current-sub">${sub}</div>` : '') +
          `</div>` +
          `<button class="anc-remove">Remove</button>` +
        `</div>`;
      box.querySelector('.anc-remove').addEventListener('click', () => removeCurrent());
    }

    function setStatus(msg, cls) {
      if (!manageEl) return;
      const el = manageEl.querySelector('.anc-status'); if (!el) return;
      el.textContent = msg || ''; el.className = 'anc-status' + (cls ? ' ' + cls : '');
    }

    function renderManageShell() {
      if (!manageEl) return;
      manageEl.innerHTML =
        `<div class="anc-manage">` +
          `<textarea class="anc-input" maxlength="500" placeholder="One short message to the office team…"></textarea>` +
          `<div class="anc-audience"><span class="anc-audience-label">Who sees it</span>` +
            `<label><input type="checkbox" class="anc-aud" value="manager" checked> Manager</label>` +
            `<label><input type="checkbox" class="anc-aud" value="advisor" checked> Advisor</label>` +
            `<label><input type="checkbox" class="anc-aud" value="bookkeeping" checked> Bookkeeping</label>` +
          `</div>` +
          `<div class="anc-controls">` +
            `<select class="anc-style"><option value="normal">Normal</option><option value="important">Important</option></select>` +
            `<label>Hide after <input type="date" class="anc-expires"></label>` +
            `<button class="anc-post">Post</button>` +
          `</div>` +
          `<div class="anc-status"></div>` +
          `<div class="anc-current"></div>` +
        `</div>`;
      manageEl.querySelector('.anc-post').addEventListener('click', postNew);
      renderManageCurrent();
    }

    // ── data ──
    async function refetch() {
      const nowIso = new Date().toISOString();
      let q = db.from('announcements').select('*')
        .is('removed_at', null)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
      if (role) q = q.contains('audience', [role]);   // this board's role must be in the audience
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) {
        if (isMissingTable(error)) { current = null; renderBanner(); if (manageEl) setStatus('Run the announcements migration to enable this.', 'err'); return; }
        console.warn('[announcement] fetch failed', error.message); return;
      }
      current = (data && data[0]) || null;
      renderBanner();
      renderManageCurrent();
    }

    // ── owner actions (service-role endpoint) ──
    async function postNew() {
      if (!manageEl) return;
      const msg = (manageEl.querySelector('.anc-input').value || '').trim();
      if (!msg) { setStatus('Enter a message.', 'err'); return; }
      const audience = [...manageEl.querySelectorAll('.anc-aud:checked')].map(c => c.value);
      if (!audience.length) { setStatus('Pick at least one — Manager / Advisor / Bookkeeping.', 'err'); return; }
      const style = manageEl.querySelector('.anc-style').value === 'important' ? 'important' : 'normal';
      const dateVal = manageEl.querySelector('.anc-expires').value;
      let expires_at = null;
      if (dateVal) { const [y, m, d] = dateVal.split('-').map(Number); expires_at = new Date(y, m - 1, d, 23, 59, 59).toISOString(); }
      const btn = manageEl.querySelector('.anc-post'); btn.disabled = true; setStatus('Posting…', 'wait');
      try {
        const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', message: msg, style, expires_at, audience, posted_by_name: getName() || null }) });
        if (!resp.ok) { let m = 'HTTP ' + resp.status; try { const j = await resp.json(); if (j && j.error) m = j.error; } catch (_) {} throw new Error(m); }
        manageEl.querySelector('.anc-input').value = ''; manageEl.querySelector('.anc-expires').value = '';
        setStatus('Posted ✓', 'ok');
        await refetch();     // realtime will also fire for other boards
      } catch (e) { console.error('[announcement] post failed', e); setStatus('Could not post: ' + (e.message || e), 'err'); }
      finally { btn.disabled = false; }
    }
    async function removeCurrent() {
      if (!current) return;
      if (!confirm('Remove this announcement for everyone?')) return;
      setStatus('Removing…', 'wait');
      try {
        const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', id: current.id }) });
        if (!resp.ok) { let m = 'HTTP ' + resp.status; try { const j = await resp.json(); if (j && j.error) m = j.error; } catch (_) {} throw new Error(m); }
        setStatus('Removed ✓', 'ok');
        await refetch();
      } catch (e) { console.error('[announcement] remove failed', e); setStatus('Could not remove: ' + (e.message || e), 'err'); }
    }

    // ── realtime + self-heal (encapsulated; no board wiring required) ──
    function resubscribe() {
      if (channel) db.removeChannel(channel);
      channel = db.channel('announcements-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, () => refetch())
        .subscribe();
    }
    function healthy() { return !!channel && channel.state === 'joined'; }
    function ensureHealth() {
      if (!healthy()) resubscribe();
      if (document.visibilityState === 'visible') refetch();
    }
    function wireSelfHealNet() {
      if (netWired) return; netWired = true;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ensureHealth(); });
      window.addEventListener('focus', ensureHealth);
      setInterval(ensureHealth, 60 * 1000);
    }

    if (manageEl) renderManageShell();
    resubscribe();
    wireSelfHealNet();
    refetch();

    return { refetch, resubscribe, healthy };
  }

  return { init };
})();
