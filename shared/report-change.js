/* ============================================================
   report-change.js — the office "Report a Change" intake (Phase 1).

   The inbound counterpart to the announcement banner. One self-injecting IIFE
   with TWO roles, like announcement-banner.js:

   SUBMIT (the three office boards) — a "🚩 Report a change" button in the
   .view-topbar opens a modal: Bug/Idea toggle · priority (the To-Do scale) · a
   plain note · an OPTIONAL screenshot upload with preview · submit. Requires a
   note OR a screenshot. Silently captures context (board, active view, RO if in
   scope, /api/version build, user-agent, submitter id/name/role):
     ReportChange.init({
       db, endpoint: '/api/change-request',
       board: 'advisor',                       // 'manager' | 'advisor' | 'bookkeeping'
       getName: () => CHAT_IDENTITY.name,
       getRole: () => CHAT_IDENTITY.role,      // falls back to `board` if null
       getEmployeeId: () => CURRENT_EMPLOYEE_ID,
       getRo: () => null,                      // optional: current RO # if one is in scope
     });

   TRIAGE (the owner board's Team Comms tab) — a "Requests & Feedback" card above
   "Post an announcement": lists requests with type/priority chips, the note, the
   screenshot (signed URL), the auto-context, a status control (new → reviewing →
   in_progress → done / not_now / wont_build) and a neutral "Send update to
   <submitter>" note (writes the denormalized owner_note):
     ReportChange.init({ db, endpoint: '/api/change-request', triageMount: '#requests-triage', getName: () => CHAT_IDENTITY.name });

   SECURITY: reading is anon SELECT. Creating/triaging is service-role only, via
   `endpoint` (api/change-request.js) — the board's anon key cannot write this
   table. Screenshots reuse the existing private crisdata-attachments bucket under
   reports/<uuid>/… (anon upload, short-lived signed-URL read) — no new storage.

   REALTIME + SELF-HEAL: the triage panel owns its own realtime channel AND its
   connection-health net (re-subscribe on focus / visibilitychange / a 60s tick),
   the same encapsulated pattern as announcement-banner.js — no board wiring.
   ============================================================ */

window.ReportChange = (function () {
  'use strict';

  const BUCKET = 'crisdata-attachments';                 // reuse chat/todo private bucket
  const SHOT_MAX_BYTES = 15 * 1024 * 1024;               // screenshots stay small
  const SIGNED_TTL = 3600;

  const TYPES = [
    { key: 'bug', label: 'Bug', emoji: '🐞' },
    { key: 'idea', label: 'Idea', emoji: '💡' },
  ];
  const PRIORITIES = [
    { key: 'immediate', label: 'Immediate' },
    { key: 'high', label: 'High' },
    { key: 'normal', label: 'Normal' },
    { key: 'low', label: 'Low' },
  ];
  const PRIO_WEIGHT = { immediate: 0, high: 1, normal: 2, low: 3 };
  const STATUSES = [
    { key: 'new', label: 'New' },
    { key: 'reviewing', label: 'Reviewing' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'done', label: 'Done' },
    { key: 'not_now', label: 'Not now' },
    { key: 'wont_build', label: "Won't build" },
  ];
  const OPEN_STATUSES = ['new', 'reviewing', 'in_progress'];
  const statusLabel = (k) => (STATUSES.find(s => s.key === k) || { label: k }).label;
  const roleLabel = (r) => (r ? r.charAt(0).toUpperCase() + r.slice(1) : '');

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function isMissingTable(err) {
    return !!err && (err.code === '42P01' || /does not exist|find the table/i.test(err.message || ''));
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // ── shared styles (namespaced .rc-*) ──
  let stylesInjected = false;
  function injectStyle() {
    if (stylesInjected) return; stylesInjected = true;
    const st = document.createElement('style');
    st.setAttribute('data-report-change', '');
    st.textContent = `
    /* topbar launcher */
    .rc-launch { margin-left:auto; display:inline-flex; align-items:center; gap:7px; border:1px solid var(--border); background:var(--surface,#fff); color:var(--text); border-radius:8px; padding:7px 13px; font:inherit; font-size:0.8rem; font-weight:700; cursor:pointer; white-space:nowrap; }
    .rc-launch:hover { border-color:var(--accent); color:var(--accent); }
    .rc-launch .rc-launch-emoji { font-size:0.95rem; line-height:1; }
    @media (max-width:768px){ .rc-launch .rc-launch-text{ display:none; } .rc-launch{ padding:7px 10px; } }

    /* modal */
    .rc-overlay { display:none; position:fixed; inset:0; background:rgba(20,22,40,0.5); z-index:6100; align-items:center; justify-content:center; padding:16px; }
    .rc-overlay.open { display:flex; }
    .rc-box { background:var(--surface,#fff); border-radius:14px; padding:22px; width:440px; max-width:94vw; max-height:92vh; overflow:auto; box-shadow:0 20px 50px rgba(0,0,0,0.28); position:relative; }
    .rc-box h3 { font-size:1.05rem; color:var(--text); margin:0 0 2px; }
    .rc-box .rc-sub { font-size:0.78rem; color:var(--muted); margin-bottom:16px; }
    .rc-close { position:absolute; top:15px; right:17px; background:none; border:none; font-size:1.35rem; color:var(--muted); cursor:pointer; line-height:1; }
    .rc-close:hover { color:var(--text); }
    .rc-field { margin-bottom:14px; }
    .rc-label { display:block; font-size:0.68rem; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:7px; }
    /* type toggle */
    .rc-seg { display:flex; gap:8px; }
    .rc-seg button { flex:1; display:flex; align-items:center; justify-content:center; gap:7px; padding:10px; border:1px solid var(--border); border-radius:9px; background:var(--surface,#fff); color:var(--text); font:inherit; font-size:0.85rem; font-weight:700; cursor:pointer; }
    .rc-seg button:hover { border-color:var(--accent); }
    .rc-seg button.on { border-color:var(--accent); background:#f0f1ff; color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent); }
    .rc-seg button .rc-seg-emoji { font-size:1.05rem; }
    .rc-row { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; }
    .rc-row .rc-field { flex:1; min-width:130px; margin-bottom:0; }
    .rc-select { width:100%; border:1px solid var(--border); border-radius:8px; padding:8px 10px; font:inherit; font-size:0.85rem; color:var(--text); background:var(--surface,#fff); cursor:pointer; }
    .rc-select:focus { outline:none; border-color:var(--accent); }
    .rc-textarea { width:100%; box-sizing:border-box; border:1px solid var(--border); border-radius:8px; padding:9px 11px; font:inherit; font-size:0.88rem; color:var(--text); background:var(--surface,#fff); resize:vertical; min-height:84px; }
    .rc-textarea:focus { outline:none; border-color:var(--accent); }
    /* screenshot */
    .rc-shot-pick { display:inline-flex; align-items:center; gap:8px; border:1px dashed var(--border); border-radius:8px; padding:9px 13px; font-size:0.82rem; font-weight:600; color:var(--muted); background:var(--surface,#fff); cursor:pointer; }
    .rc-shot-pick:hover { border-color:var(--accent); color:var(--accent); }
    .rc-shot-preview { position:relative; margin-top:10px; border:1px solid var(--border); border-radius:9px; overflow:hidden; background:#0d0f18; max-height:220px; display:flex; align-items:center; justify-content:center; }
    .rc-shot-preview img { max-width:100%; max-height:220px; display:block; }
    .rc-shot-remove { position:absolute; top:7px; right:7px; border:none; background:rgba(0,0,0,0.6); color:#fff; border-radius:20px; width:26px; height:26px; font-size:1rem; cursor:pointer; line-height:1; }
    .rc-actions { display:flex; align-items:center; gap:12px; margin-top:4px; }
    .rc-submit { margin-left:auto; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:8px; padding:9px 18px; font:inherit; font-size:0.85rem; font-weight:800; cursor:pointer; }
    .rc-submit:hover { filter:brightness(0.96); }
    .rc-submit:disabled { opacity:0.6; cursor:default; }
    .rc-status { font-size:0.8rem; min-height:1em; }
    .rc-status.ok { color:var(--green,#15803d); } .rc-status.err { color:var(--red); } .rc-status.wait { color:var(--accent); }

    /* chips (shared submit + triage) */
    .rc-chip { display:inline-flex; align-items:center; gap:5px; font-size:0.68rem; font-weight:800; padding:2px 9px; border-radius:20px; border:1px solid var(--border); white-space:nowrap; }
    .rc-chip-bug { color:var(--red); border-color:#fecaca; background:#fef2f2; }
    .rc-chip-idea { color:var(--amber); border-color:#fde68a; background:#fffbeb; }

    /* triage card */
    .rc-triage-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
    .rc-triage-filters { display:flex; align-items:center; gap:8px; margin-left:auto; flex-wrap:wrap; }
    .rc-triage-filters select { border:1px solid var(--border); border-radius:7px; padding:5px 8px; font:inherit; font-size:0.78rem; color:var(--text); background:var(--surface,#fff); cursor:pointer; }
    .rc-count { font-size:0.72rem; font-weight:700; color:var(--muted); }
    .rc-empty { color:var(--muted); font-size:0.85rem; padding:22px; text-align:center; }
    .rc-list { display:flex; flex-direction:column; gap:12px; }
    .rc-item { border:1px solid var(--border); border-left:3px solid var(--border); border-radius:10px; padding:13px 15px; background:var(--surface,#fff); }
    .rc-item.prio-immediate { border-left-color:var(--red); }
    .rc-item.prio-high { border-left-color:var(--amber); }
    .rc-item.prio-normal { border-left-color:var(--border); }
    .rc-item.prio-low { border-left-color:var(--muted); }
    .rc-item.is-closed { opacity:0.72; }
    .rc-item-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
    .rc-item-who { font-size:0.82rem; font-weight:700; color:var(--text); }
    .rc-item-role { font-size:0.72rem; color:var(--muted); font-weight:600; }
    .rc-item-when { font-size:0.72rem; color:var(--muted); margin-left:auto; }
    .rc-item-body { font-size:0.86rem; color:var(--text); line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; margin:2px 0 10px; }
    .rc-item-body.none { color:var(--muted); font-style:italic; }
    .rc-shot-thumb { display:block; margin:0 0 10px; border:1px solid var(--border); border-radius:8px; overflow:hidden; max-width:260px; }
    .rc-shot-thumb img { display:block; width:100%; height:auto; }
    .rc-ctx { font-size:0.72rem; color:var(--muted); background:var(--bg,#f5f6fa); border:1px solid var(--border); border-radius:8px; padding:8px 10px; margin-bottom:10px; line-height:1.55; overflow-wrap:anywhere; }
    .rc-ctx b { color:var(--text); font-weight:700; }
    .rc-item-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .rc-item-controls .rc-label { margin:0; }
    .rc-note-wrap { margin-top:10px; display:flex; flex-direction:column; gap:6px; }
    .rc-note-in { width:100%; box-sizing:border-box; border:1px solid var(--border); border-radius:8px; padding:8px 10px; font:inherit; font-size:0.82rem; color:var(--text); background:var(--surface,#fff); resize:vertical; min-height:46px; }
    .rc-note-in:focus { outline:none; border-color:var(--accent); }
    .rc-note-sent { font-size:0.74rem; color:var(--muted); }
    .rc-note-row { display:flex; align-items:center; gap:10px; }
    .rc-note-send { border:1px solid var(--border); background:var(--surface,#fff); color:var(--text); border-radius:7px; padding:6px 12px; font:inherit; font-size:0.78rem; font-weight:700; cursor:pointer; }
    .rc-note-send:hover { border-color:var(--accent); color:var(--accent); }
    .rc-item-status { font-size:0.8rem; }
    .rc-row-status { min-height:1em; font-size:0.74rem; }
    .rc-row-status.ok { color:var(--green,#15803d); } .rc-row-status.err { color:var(--red); } .rc-row-status.wait { color:var(--accent); }
    `;
    document.head.appendChild(st);
  }

  // ════════════════════════════════════════════════════════════
  // SUBMIT ROLE
  // ════════════════════════════════════════════════════════════
  function initSubmit(config) {
    const db = config.db;
    const endpoint = config.endpoint || '/api/change-request';
    const board = config.board || null;
    const getName = config.getName || (() => null);
    const getRole = config.getRole || (() => null);
    const getEmployeeId = config.getEmployeeId || (() => null);
    const getRo = config.getRo || (() => null);

    let modalEl = null;
    let busy = false;
    let curType = 'bug';
    let pendingFile = null;
    let pendingPreviewUrl = null;
    let appVersion = null, versionFetched = false;

    // fetch the deployed build SHA once (best-effort; null if unavailable)
    async function ensureVersion() {
      if (versionFetched) return appVersion;
      versionFetched = true;
      try { const r = await fetch('/api/version', { cache: 'no-store' }); const j = await r.json(); appVersion = (j && j.version) || null; }
      catch (_) { appVersion = null; }
      return appVersion;
    }

    function mountButton() {
      const bar = document.querySelector('.view-topbar');
      if (!bar || bar.querySelector('.rc-launch')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rc-launch';
      btn.title = 'Report a change';
      btn.innerHTML = `<span class="rc-launch-emoji">🚩</span><span class="rc-launch-text">Report a change</span>`;
      btn.addEventListener('click', openModal);
      bar.appendChild(btn);
    }

    function clearPending() {
      pendingFile = null;
      if (pendingPreviewUrl) { URL.revokeObjectURL(pendingPreviewUrl); pendingPreviewUrl = null; }
      if (modalEl) modalEl.querySelector('#rcShotWrap').innerHTML = '';
    }

    function setStatus(msg, cls) {
      const el = modalEl.querySelector('#rcStatus');
      el.textContent = msg || ''; el.className = 'rc-status' + (cls ? ' ' + cls : '');
    }
    function setType(t) {
      curType = t;
      modalEl.querySelectorAll('.rc-seg button').forEach(b => b.classList.toggle('on', b.dataset.type === t));
    }

    function ensureModal() {
      if (modalEl) return modalEl;
      modalEl = document.createElement('div');
      modalEl.className = 'rc-overlay';
      modalEl.innerHTML =
        `<div class="rc-box">
          <button type="button" class="rc-close" id="rcClose">&times;</button>
          <h3>Report a change</h3>
          <div class="rc-sub">Something broken, or an idea? Send it here — it reaches the owner and gets tracked.</div>

          <div class="rc-field">
            <span class="rc-label">Type</span>
            <div class="rc-seg">
              ${TYPES.map(t => `<button type="button" data-type="${t.key}"><span class="rc-seg-emoji">${t.emoji}</span>${t.label}</button>`).join('')}
            </div>
          </div>

          <div class="rc-field" style="max-width:180px">
            <span class="rc-label">Priority</span>
            <select class="rc-select" id="rcPriority">
              ${PRIORITIES.map(p => `<option value="${p.key}"${p.key === 'normal' ? ' selected' : ''}>${p.label}</option>`).join('')}
            </select>
          </div>

          <div class="rc-field">
            <span class="rc-label">What's going on?</span>
            <textarea class="rc-textarea" id="rcBody" maxlength="5000" placeholder="Describe the bug or the idea… (or just attach a screenshot)"></textarea>
          </div>

          <div class="rc-field">
            <span class="rc-label">Screenshot (optional)</span>
            <label class="rc-shot-pick">📎 Upload a screenshot<input type="file" accept="image/*" id="rcShotInput" style="display:none"></label>
            <div id="rcShotWrap"></div>
          </div>

          <div class="rc-actions">
            <div class="rc-status" id="rcStatus"></div>
            <button type="button" class="rc-submit" id="rcSubmit">Send</button>
          </div>
        </div>`;
      document.body.appendChild(modalEl);

      modalEl.querySelector('#rcClose').addEventListener('click', closeModal);
      modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
      modalEl.querySelectorAll('.rc-seg button').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));
      modalEl.querySelector('#rcShotInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) onShotPicked(file);
        e.target.value = '';   // reset AFTER grabbing the File (catch-moment ordering fix)
      });
      modalEl.querySelector('#rcSubmit').addEventListener('click', doSubmit);
      return modalEl;
    }

    function onShotPicked(file) {
      if (!file.type.startsWith('image/')) { setStatus('Please choose an image.', 'err'); return; }
      if (!file.size) { setStatus('That file looks empty — try again.', 'err'); return; }
      if (file.size > SHOT_MAX_BYTES) { setStatus('That image is over 15 MB — please shrink it.', 'err'); return; }
      clearPending();
      pendingFile = file;
      pendingPreviewUrl = URL.createObjectURL(file);
      modalEl.querySelector('#rcShotWrap').innerHTML =
        `<div class="rc-shot-preview"><img src="${pendingPreviewUrl}" alt="screenshot preview"><button type="button" class="rc-shot-remove" id="rcShotRemove" title="Remove">&times;</button></div>`;
      modalEl.querySelector('#rcShotRemove').addEventListener('click', () => { clearPending(); setStatus(''); });
      setStatus('');
    }

    function openModal() {
      ensureModal();
      clearPending();
      setType('bug');
      modalEl.querySelector('#rcBody').value = '';
      modalEl.querySelector('#rcPriority').value = 'normal';
      setStatus('');
      modalEl.classList.add('open');
      ensureVersion();   // warm the build SHA while they type
    }
    function closeModal() { clearPending(); if (modalEl) modalEl.classList.remove('open'); }

    async function doSubmit() {
      if (busy) return;
      const bodyText = (modalEl.querySelector('#rcBody').value || '').trim();
      if (!bodyText && !pendingFile) { setStatus('Add a note or a screenshot.', 'err'); return; }

      busy = true;
      const btn = modalEl.querySelector('#rcSubmit'); btn.disabled = true;
      setStatus('Sending…', 'wait');
      try {
        // 1) upload the screenshot FIRST (a failed upload never leaves a dangling pointer)
        let screenshot_path = null, screenshot_name = null, screenshot_mime = null;
        if (pendingFile) {
          const id = crypto.randomUUID();
          const ext = (pendingFile.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
          const path = `reports/${id}/screenshot.${ext}`;
          const { error: upErr } = await db.storage.from(BUCKET).upload(path, pendingFile, { contentType: pendingFile.type || 'image/png', upsert: false });
          if (upErr) throw upErr;
          screenshot_path = path;
          screenshot_name = pendingFile.name ? String(pendingFile.name).slice(0, 200) : `screenshot.${ext}`;
          screenshot_mime = pendingFile.type || null;
        }

        // 2) gather silent context
        const activeItem = document.querySelector('.sidebar-item.active[data-view]');
        const context_view = activeItem ? activeItem.dataset.view : null;
        const version = await ensureVersion();

        // 3) POST create (service-role endpoint)
        const payload = {
          action: 'create',
          type: curType,
          priority: modalEl.querySelector('#rcPriority').value,
          body: bodyText || null,
          screenshot_path, screenshot_name, screenshot_mime,
          submitted_by_id: getEmployeeId() || null,
          submitted_by_name: getName() || null,
          submitted_by_role: getRole() || board || null,
          context_board: board || null,
          context_view,
          context_ro: getRo() || null,
          app_version: version,
          user_agent: navigator.userAgent || null,
        };
        const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!resp.ok) { let m = 'HTTP ' + resp.status; try { const j = await resp.json(); if (j && j.error) m = j.error; } catch (_) {} throw new Error(m); }

        setStatus('Sent ✓ Thanks — the owner will see it.', 'ok');
        setTimeout(() => { if (modalEl.classList.contains('open')) closeModal(); }, 1100);
      } catch (e) {
        console.error('[ReportChange] submit failed', e);
        const missing = e && /bucket|not found|does not exist/i.test(e.message || '');
        setStatus('Could not send: ' + (e.message || 'unknown error') + (missing ? ' (has the migration been run?)' : ''), 'err');
      } finally {
        busy = false; btn.disabled = false;
      }
    }

    injectStyle();
    mountButton();
    return { open: openModal };
  }

  // ════════════════════════════════════════════════════════════
  // TRIAGE ROLE
  // ════════════════════════════════════════════════════════════
  function initTriage(config) {
    const db = config.db;
    const endpoint = config.endpoint || '/api/change-request';
    const mountEl = document.querySelector(config.triageMount);
    if (!mountEl) return {};

    let rows = [];
    let channel = null, netWired = false;
    let filterStatus = 'open';      // 'open' | 'all' | a specific status
    let sortBy = 'priority';        // 'priority' | 'newest'
    const signedCache = new Map();  // path -> signed url (per session)

    mountEl.innerHTML =
      `<div class="card">
        <div class="rc-triage-head">
          <div class="card-title" style="margin:0"><div class="dot" style="background:var(--accent)"></div>Requests &amp; Feedback <span class="rc-count" id="rcCount"></span></div>
          <div class="rc-triage-filters">
            <select id="rcFilterStatus">
              <option value="open" selected>Open</option>
              <option value="all">All</option>
              ${STATUSES.map(s => `<option value="${s.key}">${s.label}</option>`).join('')}
            </select>
            <select id="rcSort">
              <option value="priority" selected>Priority</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>
        <div class="rc-list" id="rcList"><div class="rc-empty">Loading…</div></div>
      </div>`;

    mountEl.querySelector('#rcFilterStatus').addEventListener('change', (e) => { filterStatus = e.target.value; render(); });
    mountEl.querySelector('#rcSort').addEventListener('change', (e) => { sortBy = e.target.value; render(); });

    function visibleRows() {
      let list = rows.slice();
      if (filterStatus === 'open') list = list.filter(r => OPEN_STATUSES.includes(r.status));
      else if (filterStatus !== 'all') list = list.filter(r => r.status === filterStatus);
      list.sort((a, b) => {
        if (sortBy === 'priority') {
          const w = (PRIO_WEIGHT[a.priority] ?? 2) - (PRIO_WEIGHT[b.priority] ?? 2);
          if (w !== 0) return w;
        }
        return new Date(b.created_at) - new Date(a.created_at);   // newest first
      });
      return list;
    }

    function render() {
      const listEl = mountEl.querySelector('#rcList');
      const countEl = mountEl.querySelector('#rcCount');
      if (!listEl) return;
      const openCount = rows.filter(r => OPEN_STATUSES.includes(r.status)).length;
      countEl.textContent = openCount ? `${openCount} open` : '';
      const list = visibleRows();
      if (!list.length) { listEl.innerHTML = `<div class="rc-empty">${rows.length ? 'Nothing here for this filter.' : 'No requests yet. When the team sends one, it lands here.'}</div>`; return; }
      listEl.innerHTML = list.map(rowHtml).join('');
      list.forEach(r => wireRow(listEl, r));
    }

    function rowHtml(r) {
      const type = TYPES.find(t => t.key === r.type) || { emoji: '', label: r.type };
      const prio = PRIORITIES.find(p => p.key === r.priority) || { label: r.priority };
      const closed = !OPEN_STATUSES.includes(r.status);
      const who = esc(r.submitted_by_name || 'Someone');
      const role = r.submitted_by_role ? `<span class="rc-item-role">· ${esc(roleLabel(r.submitted_by_role))}</span>` : '';
      const prioPill = `<span class="todo-prio-tag todo-prio-tag-${esc(r.priority)}">${esc(prio.label)}</span>`;

      const ctxBits = [];
      if (r.context_board) ctxBits.push(`<b>${esc(roleLabel(r.context_board))}</b> board`);
      if (r.context_view) ctxBits.push(`on <b>${esc(r.context_view)}</b>`);
      if (r.context_ro) ctxBits.push(`RO <b>${esc(r.context_ro)}</b>`);
      const ctxLine2 = [];
      if (r.app_version) ctxLine2.push(`build <b>${esc(String(r.app_version).slice(0, 7))}</b>`);
      if (r.user_agent) ctxLine2.push(esc(r.user_agent));

      const noteSent = (r.owner_note && r.owner_note_at)
        ? `<div class="rc-note-sent">Last update sent ${esc(fmtWhen(r.owner_note_at))}</div>` : '';

      return `<div class="rc-item prio-${esc(r.priority)}${closed ? ' is-closed' : ''}" data-id="${esc(r.id)}">
        <div class="rc-item-top">
          <span class="rc-chip rc-chip-${esc(r.type)}">${type.emoji} ${esc(type.label)}</span>
          ${prioPill}
          <span class="rc-item-who">${who}</span>${role}
          <span class="rc-item-when">${esc(fmtWhen(r.created_at))}</span>
        </div>
        <div class="rc-item-body${r.body ? '' : ' none'}">${r.body ? esc(r.body) : 'No note — screenshot only.'}</div>
        <div class="rc-shot-slot" data-path="${esc(r.screenshot_path || '')}"></div>
        <div class="rc-ctx">${ctxBits.join(' ') || 'No screen context captured.'}${ctxLine2.length ? '<br>' + ctxLine2.join(' · ') : ''}</div>
        <div class="rc-item-controls">
          <span class="rc-label">Status</span>
          <select class="rc-select rc-item-status" style="max-width:160px">
            ${STATUSES.map(s => `<option value="${s.key}"${s.key === r.status ? ' selected' : ''}>${s.label}</option>`).join('')}
          </select>
          <span class="rc-row-status"></span>
        </div>
        <div class="rc-note-wrap">
          <span class="rc-label">Send update to ${who}</span>
          ${noteSent}
          <textarea class="rc-note-in" maxlength="2000" placeholder="A short, neutral update — not a promise (e.g. 'Looking into this,' 'Not planned right now').">${esc(r.owner_note || '')}</textarea>
          <div class="rc-note-row"><button type="button" class="rc-note-send">Send update</button><span class="rc-row-status rc-note-status"></span></div>
        </div>
      </div>`;
    }

    async function wireRow(listEl, r) {
      const el = listEl.querySelector(`.rc-item[data-id="${r.id}"]`);
      if (!el) return;

      // status control
      const sel = el.querySelector('.rc-item-status');
      const rowStatus = el.querySelector('.rc-item-controls .rc-row-status');
      sel.addEventListener('change', async () => {
        rowStatus.textContent = 'Saving…'; rowStatus.className = 'rc-row-status wait';
        const ok = await triage({ id: r.id, status: sel.value });
        if (ok) { rowStatus.textContent = 'Saved ✓'; rowStatus.className = 'rc-row-status ok'; }
        else { rowStatus.textContent = 'Failed'; rowStatus.className = 'rc-row-status err'; sel.value = r.status; }
      });

      // owner note
      const noteIn = el.querySelector('.rc-note-in');
      const noteBtn = el.querySelector('.rc-note-send');
      const noteStatus = el.querySelector('.rc-note-status');
      noteBtn.addEventListener('click', async () => {
        const note = (noteIn.value || '').trim();
        if (!note) { noteStatus.textContent = 'Type a note first.'; noteStatus.className = 'rc-row-status err'; return; }
        noteBtn.disabled = true; noteStatus.textContent = 'Sending…'; noteStatus.className = 'rc-row-status wait';
        const ok = await triage({ id: r.id, status: sel.value, owner_note: note });
        if (ok) { noteStatus.textContent = 'Update saved ✓'; noteStatus.className = 'rc-row-status ok'; }
        else { noteStatus.textContent = 'Failed'; noteStatus.className = 'rc-row-status err'; }
        noteBtn.disabled = false;
      });

      // screenshot (signed URL, lazy)
      const slot = el.querySelector('.rc-shot-slot');
      const path = slot && slot.dataset.path;
      if (slot && path) {
        try {
          let url = signedCache.get(path);
          if (!url) {
            const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
            if (error) throw error;
            url = data.signedUrl; signedCache.set(path, url);
          }
          slot.innerHTML = `<a class="rc-shot-thumb" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="screenshot"></a>`;
        } catch (e) { /* leave empty on failure */ }
      }
    }

    async function triage(payload) {
      try {
        const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'triage', ...payload }) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return true;
      } catch (e) { console.error('[ReportChange] triage failed', e); return false; }
    }

    async function refetch() {
      const { data, error } = await db.from('change_requests').select('*').order('created_at', { ascending: false });
      if (error) {
        if (isMissingTable(error)) { rows = []; mountEl.querySelector('#rcList').innerHTML = '<div class="rc-empty">Run the change_requests migration to enable this.</div>'; return; }
        console.warn('[ReportChange] fetch failed', error.message); return;
      }
      rows = data || [];
      render();
    }

    // realtime + self-heal (encapsulated; no board wiring required)
    function resubscribe() {
      if (channel) db.removeChannel(channel);
      channel = db.channel('change-requests-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'change_requests' }, () => refetch())
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

    injectStyle();
    resubscribe();
    wireSelfHealNet();
    refetch();
    return { refetch, resubscribe, healthy };
  }

  // ── one entry, two roles (like announcement-banner) ──
  function init(config) {
    const c = config || {};
    let submit = null, triage = null;
    if (c.board) submit = initSubmit(c);
    if (c.triageMount) triage = initTriage(c);
    return { submit, triage };
  }

  return { init };
})();
