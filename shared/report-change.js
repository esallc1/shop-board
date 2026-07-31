/* ============================================================
   report-change.js — the office "Report a Change" intake (Phase 1 + 2 + 3).

   The inbound counterpart to the announcement banner. One self-injecting IIFE
   with TWO roles, like announcement-banner.js:

   SUBMIT (the three office boards) — a "🚩 Report a change" button in the
   .view-topbar opens a modal with two tabs:
     • "Report" — Bug/Idea toggle · priority (the To-Do scale) · a plain note · an
       OPTIONAL screenshot · submit (note OR screenshot). The screenshot can be
       "📸 Grab my board" (Phase 3: a one-click html2canvas capture of the current
       board) OR "⬆ Upload a screenshot" — both feed the SAME annotator (draw red
       ARROWS, drop draggable text-bubble NOTES, Undo/Clear). On submit, if the
       user annotated, image+markup are FLATTENED to one PNG (html2canvas); else the
       base image uploads untouched. html2canvas is vendored (vendor/html2canvas.min.js,
       MIT) and lazy-loaded. Annotation is optional — text-only + plain-upload still work.
     • "My requests" (Phase 2) — a READ-ONLY list of the current user's own
       submissions (client-side filter by submitted_by_id over anon SELECT), each
       showing type/priority chips, the status, the screenshot, and the latest
       owner_note back. A per-device unread badge on the 🚩 button + tab flags a
       status change or a new owner_note the user hasn't seen (localStorage
       seen-map, mirroring the announcement banner's per-device dismiss). It has
       its OWN realtime channel + self-heal so updates land without a refresh.
   Submitting silently captures context (board, active view, RO if in scope,
   /api/version build, user-agent, submitter id/name/role):
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
  // Phase 3 — capture + annotate. html2canvas is VENDORED (vendor/html2canvas.min.js,
  // MIT) and LAZY-loaded on first "Grab my board" or first flatten, so no board pays
  // for it on load and nothing references a CDN.
  const H2C_SRC = '/vendor/html2canvas.min.js';
  const ARROW_COLOR = '#d83a3a';                          // annotation red (matches the prototype)
  const MIN_ARROW = 14;                                   // px — a shorter drag is a mis-click, discarded

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

  // ── "My requests" per-device seen-tracking (Phase 2) ──
  // Mirrors the announcement banner's per-device dismiss: nothing server-side,
  // just a localStorage map { requestId: signature }. A request counts as
  // "unread" once it has PROGRESSED past the pristine (new, no note) state to a
  // signature the user hasn't seen on THIS device.
  const SEEN_KEY = 'crisdata_seen_requests';
  function loadSeen() {
    try { const m = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); return (m && typeof m === 'object') ? m : {}; }
    catch (_) { return {}; }
  }
  function saveSeen(m) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (_) {} }
  function reqSig(r) { return `${r.status}::${r.owner_note_at || ''}`; }         // changes on a status move OR a new note
  function reqProgressed(r) { return r.status !== 'new' || !!r.owner_note; }      // pristine new-with-no-note is never "unread"
  function isUnread(r, seen) { return reqProgressed(r) && seen[r.id] !== reqSig(r); }

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

    /* ── Phase 2: launcher unread badge ── */
    .rc-launch { position:relative; }
    .rc-launch-badge { min-width:16px; height:16px; padding:0 4px; border-radius:9px; background:var(--red); color:#fff; font-size:0.62rem; font-weight:800; line-height:16px; text-align:center; box-shadow:0 0 0 2px var(--surface,#fff); }

    /* ── Phase 2: modal tabs ── */
    .rc-tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); margin:-4px -4px 16px; padding:0 2px; }
    .rc-tab { position:relative; border:none; background:none; padding:9px 12px 10px; font:inherit; font-size:0.85rem; font-weight:700; color:var(--muted); cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; display:inline-flex; align-items:center; gap:7px; }
    .rc-tab:hover { color:var(--text); }
    .rc-tab.on { color:var(--accent); border-bottom-color:var(--accent); }
    .rc-tab-badge { min-width:16px; height:16px; padding:0 4px; border-radius:9px; background:var(--red); color:#fff; font-size:0.62rem; font-weight:800; line-height:16px; text-align:center; }

    /* ── Phase 2: My requests list (read-only) ── */
    .rc-mine-list { display:flex; flex-direction:column; gap:11px; }
    .rc-mine-item { border:1px solid var(--border); border-left:3px solid var(--border); border-radius:10px; padding:12px 14px; background:var(--surface,#fff); }
    .rc-mine-item.prio-immediate { border-left-color:var(--red); }
    .rc-mine-item.prio-high { border-left-color:var(--amber); }
    .rc-mine-item.prio-normal { border-left-color:var(--border); }
    .rc-mine-item.prio-low { border-left-color:var(--muted); }
    .rc-mine-item.is-unread { box-shadow:inset 3px 0 0 0 var(--accent); background:#f7f8ff; }
    .rc-mine-new { display:inline-block; font-size:0.6rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px; color:#fff; background:var(--accent); border-radius:20px; padding:1px 7px; }
    /* read-only status pill */
    .rc-status-pill { font-size:0.66rem; font-weight:800; padding:2px 9px; border-radius:20px; border:1px solid var(--border); background:var(--surface-2,#f5f6fa); color:var(--muted); white-space:nowrap; }
    .rc-status-reviewing { color:var(--accent); border-color:#c7d2fe; background:#eef2ff; }
    .rc-status-in_progress { color:var(--amber); border-color:#fde68a; background:#fffbeb; }
    .rc-status-done { color:var(--green,#15803d); border-color:#bbf7d0; background:#f0fdf4; }
    .rc-status-wont_build { color:var(--red); border-color:#fecaca; background:#fef2f2; }
    /* the owner's note back */
    .rc-update { border:1px solid #c7d2fe; background:#eef2ff; border-radius:8px; padding:8px 11px; margin-top:9px; }
    .rc-update-head { font-size:0.68rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px; color:var(--accent); margin-bottom:3px; }
    .rc-update-body { font-size:0.84rem; color:var(--text); line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }

    /* ── Phase 3: capture + annotate ── */
    .rc-shot-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .rc-shot-pick { display:inline-flex; align-items:center; gap:8px; border:1px dashed var(--border); border-radius:8px; padding:9px 13px; font:inherit; font-size:0.82rem; font-weight:600; color:var(--muted); background:var(--surface,#fff); cursor:pointer; }
    .rc-shot-pick:hover { border-color:var(--accent); color:var(--accent); }
    .rc-shot-pick.busy { opacity:0.6; cursor:default; }
    /* annotator */
    .rc-anno { margin-top:10px; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
    .rc-anno-tools { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:7px 9px; border-bottom:1px solid var(--border); background:var(--bg,#f5f6fa); }
    .rc-tool { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--border); background:var(--surface,#fff); color:var(--text); border-radius:7px; padding:5px 10px; font:inherit; font-size:0.76rem; font-weight:700; cursor:pointer; }
    .rc-tool:hover { border-color:var(--accent); }
    .rc-tool.on { border-color:var(--accent); background:var(--accent); color:#fff; }
    .rc-tool-sp { flex:1; }
    .rc-tool.ghost { color:var(--muted); font-weight:600; }
    .rc-tool.ghost:hover { color:var(--red); border-color:var(--red); }
    .rc-stage { position:relative; display:block; line-height:0; background:var(--bg,#f5f6fa); touch-action:none; }
    .rc-stage.mode-arrow { cursor:crosshair; }
    .rc-stage.mode-note { cursor:copy; }
    .rc-stage.mode-select { cursor:default; }
    .rc-anno-img { display:block; width:100%; height:auto; -webkit-user-select:none; user-select:none; -webkit-user-drag:none; pointer-events:none; }
    .rc-anno-svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
    .rc-bubble { position:absolute; min-width:120px; max-width:220px; background:#fffbe6; border:1.5px solid var(--amber); border-radius:9px; box-shadow:0 5px 16px rgba(0,0,0,0.18); z-index:5; line-height:1.3; }
    .rc-bubble-bar { height:15px; background:rgba(224,134,0,0.14); border-radius:7px 7px 0 0; cursor:move; display:flex; align-items:center; justify-content:flex-end; padding-right:3px; }
    .rc-bubble-x { font-size:0.72rem; color:var(--amber); cursor:pointer; line-height:1; padding:0 3px; font-weight:800; }
    .rc-bubble-tx { padding:5px 8px 8px; font-size:0.76rem; color:#5a4200; outline:none; min-height:26px; word-break:break-word; }
    .rc-bubble-tx:empty::before { content:attr(data-ph); color:#b08a3a; }
    /* while flattening, hide the interactive chrome so the PNG shows only art */
    .rc-stage.rc-flattening .rc-bubble-x, .rc-stage.rc-flattening .rc-bubble-bar { visibility:hidden; }
    .rc-anno-hint { font-size:0.72rem; color:var(--muted); padding:6px 9px 0; }
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
    let appVersion = null, versionFetched = false;
    // Phase 3 — screenshot capture + annotate state
    let shotBlob = null;            // the BASE image (captured canvas PNG, or the uploaded File)
    let shotName = null, shotMime = null;
    let shotSrc = null;             // object/data URL used to display it (revoked on clear)
    let stageEl = null, svgEl = null;   // the annotator DOM when an image is loaded
    let annoMode = 'arrow';         // 'arrow' | 'note' | 'select'
    let annoStack = [];             // annotation els (lines + bubbles) in creation order (for undo)
    let h2cPromise = null;          // lazy html2canvas loader (shared by capture + flatten)
    // Phase 2 — "My requests" state
    let launchBtn = null;
    let activeTab = 'report';
    let mineRows = [];
    let mineChannel = null, mineNetWired = false;
    const mineSigned = new Map();   // path -> signed url (per session)

    // fetch the deployed build SHA once (best-effort; null if unavailable)
    async function ensureVersion() {
      if (versionFetched) return appVersion;
      versionFetched = true;
      try { const r = await fetch('/api/version', { cache: 'no-store' }); const j = await r.json(); appVersion = (j && j.version) || null; }
      catch (_) { appVersion = null; }
      return appVersion;
    }

    // Lazy-load the VENDORED html2canvas (once) — used for both capture and flatten.
    function ensureHtml2Canvas() {
      if (window.html2canvas) return Promise.resolve(window.html2canvas);
      if (h2cPromise) return h2cPromise;
      h2cPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = H2C_SRC; s.async = true;
        s.onload = () => window.html2canvas ? resolve(window.html2canvas) : reject(new Error('html2canvas did not initialize'));
        s.onerror = () => reject(new Error('could not load html2canvas'));
        document.head.appendChild(s);
      });
      return h2cPromise;
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
      launchBtn = btn;
      updateBadge();   // in case mine rows are already loaded
    }

    function clearPending() {
      shotBlob = null; shotName = null; shotMime = null;
      if (shotSrc) { try { URL.revokeObjectURL(shotSrc); } catch (_) {} shotSrc = null; }
      stageEl = null; svgEl = null; annoStack = [];
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
          <div class="rc-tabs">
            <button type="button" class="rc-tab on" data-tab="report">Report</button>
            <button type="button" class="rc-tab" data-tab="mine">My requests <span class="rc-tab-badge" style="display:none"></span></button>
          </div>

          <div class="rc-tabpanel" id="rcPanelReport">
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
              <div class="rc-shot-actions">
                <button type="button" class="rc-shot-pick" id="rcGrab">📸 Grab my board</button>
                <label class="rc-shot-pick">⬆ Upload a screenshot<input type="file" accept="image/*" id="rcShotInput" style="display:none"></label>
              </div>
              <div id="rcShotWrap"></div>
            </div>

            <div class="rc-actions">
              <div class="rc-status" id="rcStatus"></div>
              <button type="button" class="rc-submit" id="rcSubmit">Send</button>
            </div>
          </div>

          <div class="rc-tabpanel" id="rcPanelMine" style="display:none">
            <h3>My requests</h3>
            <div class="rc-sub">Where your reports landed. Read-only — the owner updates the status and can send a note back.</div>
            <div class="rc-mine-list" id="rcMineList"><div class="rc-empty">Loading…</div></div>
          </div>
        </div>`;
      document.body.appendChild(modalEl);

      modalEl.querySelector('#rcClose').addEventListener('click', closeModal);
      modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
      modalEl.querySelectorAll('.rc-tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
      modalEl.querySelectorAll('.rc-seg button').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));
      modalEl.querySelector('#rcShotInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) onShotPicked(file);
        e.target.value = '';   // reset AFTER grabbing the File (catch-moment ordering fix)
      });
      modalEl.querySelector('#rcGrab').addEventListener('click', grabBoard);
      modalEl.querySelector('#rcSubmit').addEventListener('click', doSubmit);
      return modalEl;
    }

    // ── the two ways to get a base image; both feed the SAME annotator ──
    function onShotPicked(file) {
      if (!file.type.startsWith('image/')) { setStatus('Please choose an image.', 'err'); return; }
      if (!file.size) { setStatus('That file looks empty — try again.', 'err'); return; }
      if (file.size > SHOT_MAX_BYTES) { setStatus('That image is over 15 MB — please shrink it.', 'err'); return; }
      clearPending();
      shotBlob = file;
      shotName = file.name ? String(file.name).slice(0, 200) : 'screenshot.png';
      shotMime = file.type || 'image/png';
      shotSrc = URL.createObjectURL(file);
      openAnnotator(shotSrc);
      setStatus('');
    }

    async function grabBoard() {
      if (busy) return;
      const grabBtn = modalEl.querySelector('#rcGrab');
      grabBtn.classList.add('busy'); grabBtn.disabled = true;
      setStatus('Grabbing your board…', 'wait');
      // Hide the modal so it isn't in the shot; capture the visible board; restore.
      modalEl.style.visibility = 'hidden';
      try {
        const h2c = await ensureHtml2Canvas();
        // small paint gap so the hidden modal is actually off before capture
        await new Promise(r => setTimeout(r, 60));
        const canvas = await h2c(document.body, {
          backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
          useCORS: true, logging: false,
          scale: Math.min(2, window.devicePixelRatio || 1),
          x: window.scrollX, y: window.scrollY,
          width: window.innerWidth, height: window.innerHeight,
          ignoreElements: (el) => el.classList && (el.classList.contains('rc-overlay') || el.classList.contains('cm-overlay')),
        });
        modalEl.style.visibility = '';
        const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        if (!blob) throw new Error('capture produced no image');
        clearPending();
        shotBlob = blob; shotName = 'board.png'; shotMime = 'image/png';
        shotSrc = URL.createObjectURL(blob);
        openAnnotator(shotSrc);
        setStatus('Grabbed ✓ Now mark it up — or send as-is.', 'ok');
      } catch (e) {
        modalEl.style.visibility = '';
        console.error('[ReportChange] capture failed', e);
        setStatus('Couldn\'t grab the board (' + (e.message || 'error') + '). Use “Upload a screenshot” instead.', 'err');
      } finally {
        grabBtn.classList.remove('busy'); grabBtn.disabled = false;
      }
    }

    // ── the annotator: image + SVG arrows + draggable text bubbles ──
    function openAnnotator(src) {
      annoMode = 'arrow'; annoStack = [];
      const wrap = modalEl.querySelector('#rcShotWrap');
      wrap.innerHTML =
        `<div class="rc-anno">
          <div class="rc-anno-tools">
            <button type="button" class="rc-tool on" data-mode="arrow">↗ Arrow</button>
            <button type="button" class="rc-tool" data-mode="note">💬 Note</button>
            <button type="button" class="rc-tool" data-mode="select">✋ Move</button>
            <span class="rc-tool-sp"></span>
            <button type="button" class="rc-tool ghost" id="rcUndo">↶ Undo</button>
            <button type="button" class="rc-tool ghost" id="rcClearAnno">🗑 Clear</button>
            <button type="button" class="rc-tool ghost" id="rcShotRemove">✕ Remove</button>
          </div>
          <div class="rc-stage mode-arrow" id="rcStage">
            <img class="rc-anno-img" id="rcAnnoImg" alt="screenshot to annotate">
            <svg class="rc-anno-svg" id="rcAnnoSvg">
              <defs><marker id="rcArrowHead" markerWidth="10" markerHeight="10" refX="7" refY="3.2" orient="auto">
                <path d="M0,0 L8,3.2 L0,6.4 Z" fill="${ARROW_COLOR}"></path>
              </marker></defs>
            </svg>
          </div>
          <div class="rc-anno-hint">Drag to draw an arrow · pick 💬 Note to drop a label · ✋ Move to reposition.</div>
        </div>`;
      stageEl = wrap.querySelector('#rcStage');
      svgEl = wrap.querySelector('#rcAnnoSvg');
      const img = wrap.querySelector('#rcAnnoImg');
      img.src = src;

      wrap.querySelectorAll('.rc-tool[data-mode]').forEach(b =>
        b.addEventListener('click', () => setMode(b.dataset.mode)));
      wrap.querySelector('#rcUndo').addEventListener('click', undoAnno);
      wrap.querySelector('#rcClearAnno').addEventListener('click', clearAnno);
      wrap.querySelector('#rcShotRemove').addEventListener('click', () => { clearPending(); setStatus(''); });

      // arrow drawing (pointer events → mouse + touch; touch-action:none prevents scroll)
      stageEl.addEventListener('pointerdown', onStagePointerDown);
      stageEl.addEventListener('pointermove', onStagePointerMove);
      stageEl.addEventListener('pointerup', onStagePointerUp);
      stageEl.addEventListener('click', onStageClick);
    }

    function setMode(m) {
      annoMode = m;
      stageEl.className = 'rc-stage mode-' + m;
      modalEl.querySelectorAll('.rc-tool[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
      // bubbles only draggable/typable when NOT drawing arrows
      stageEl.querySelectorAll('.rc-bubble').forEach(bb => bb.style.pointerEvents = (m === 'arrow') ? 'none' : 'auto');
    }

    function stagePt(e) { const r = stageEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    let drawing = null;
    function onStagePointerDown(e) {
      if (annoMode !== 'arrow' || (e.target.closest && e.target.closest('.rc-bubble'))) return;
      const p = stagePt(e);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', p.x); line.setAttribute('y1', p.y);
      line.setAttribute('x2', p.x); line.setAttribute('y2', p.y);
      line.setAttribute('stroke', ARROW_COLOR); line.setAttribute('stroke-width', '3.5');
      line.setAttribute('stroke-linecap', 'round'); line.setAttribute('marker-end', 'url(#rcArrowHead)');
      svgEl.appendChild(line);
      drawing = { line, p };
      try { stageEl.setPointerCapture(e.pointerId); } catch (_) {}
    }
    function onStagePointerMove(e) {
      if (!drawing) return;
      const p = stagePt(e);
      drawing.line.setAttribute('x2', p.x); drawing.line.setAttribute('y2', p.y);
    }
    function onStagePointerUp(e) {
      if (!drawing) return;
      const p = stagePt(e);
      if (Math.hypot(p.x - drawing.p.x, p.y - drawing.p.y) < MIN_ARROW) drawing.line.remove();
      else annoStack.push(drawing.line);
      drawing = null;
    }
    function onStageClick(e) {
      if (annoMode !== 'note' || (e.target.closest && e.target.closest('.rc-bubble'))) return;
      const p = stagePt(e);
      addBubble(p.x, p.y, '');
    }

    function addBubble(x, y, text) {
      const b = document.createElement('div');
      b.className = 'rc-bubble';
      b.style.left = Math.max(0, Math.min(x, stageEl.clientWidth - 130)) + 'px';
      b.style.top = Math.max(0, Math.min(y, stageEl.clientHeight - 44)) + 'px';
      b.innerHTML = `<div class="rc-bubble-bar"><span class="rc-bubble-x" title="Delete">✕</span></div>` +
        `<div class="rc-bubble-tx" contenteditable="true" data-ph="What's the concern here?"></div>`;
      stageEl.appendChild(b);
      const tx = b.querySelector('.rc-bubble-tx');
      if (text) tx.textContent = text;
      b.style.pointerEvents = (annoMode === 'arrow') ? 'none' : 'auto';
      b.querySelector('.rc-bubble-x').addEventListener('click', (ev) => { ev.stopPropagation(); b.remove(); });
      // drag by the header bar
      b.querySelector('.rc-bubble-bar').addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        const r = stageEl.getBoundingClientRect();
        const offx = ev.clientX - b.offsetLeft, offy = ev.clientY - b.offsetTop;
        function mv(m) {
          b.style.left = Math.max(0, Math.min(m.clientX - offx, r.width - b.offsetWidth)) + 'px';
          b.style.top = Math.max(0, Math.min(m.clientY - offy, r.height - b.offsetHeight)) + 'px';
        }
        function up() { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); }
        document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
      });
      annoStack.push(b);
      setTimeout(() => tx.focus(), 0);
      return b;
    }

    function undoAnno() { const el = annoStack.pop(); if (el) el.remove(); }
    function clearAnno() { while (annoStack.length) annoStack.pop().remove(); }

    // Flatten image + annotations to ONE PNG blob (WYSIWYG) via html2canvas on the stage.
    async function flattenStage() {
      const h2c = await ensureHtml2Canvas();
      // blur any focused bubble so no caret is captured; hide chrome via a class
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      stageEl.classList.add('rc-flattening');
      try {
        const canvas = await h2c(stageEl, { backgroundColor: null, useCORS: true, logging: false, scale: 2 });
        return await new Promise(res => canvas.toBlob(res, 'image/png'));
      } finally {
        stageEl.classList.remove('rc-flattening');
      }
    }

    function openModal() {
      ensureModal();
      clearPending();
      setType('bug');
      modalEl.querySelector('#rcBody').value = '';
      modalEl.querySelector('#rcPriority').value = 'normal';
      setStatus('');
      // If the user has unseen updates, open straight to "My requests"; else Report.
      const hasUnread = mineRows.some(r => isUnread(r, loadSeen()));
      showTab(hasUnread ? 'mine' : 'report');
      modalEl.classList.add('open');
      ensureVersion();   // warm the build SHA while they type
    }
    function closeModal() { clearPending(); if (modalEl) modalEl.classList.remove('open'); }

    // ── tabs ──
    function showTab(t) {
      activeTab = t;
      modalEl.querySelectorAll('.rc-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
      modalEl.querySelector('#rcPanelReport').style.display = (t === 'report') ? '' : 'none';
      modalEl.querySelector('#rcPanelMine').style.display = (t === 'mine') ? '' : 'none';
      if (t === 'mine') {
        renderMine();       // paints with the current unread highlight…
        refreshMine();      // …then pulls the freshest rows in the background
        markMineSeen();     // opening the list clears the badge for what's shown
      }
    }

    async function doSubmit() {
      if (busy) return;
      const bodyText = (modalEl.querySelector('#rcBody').value || '').trim();
      if (!bodyText && !shotBlob) { setStatus('Add a note or a screenshot.', 'err'); return; }

      busy = true;
      const btn = modalEl.querySelector('#rcSubmit'); btn.disabled = true;
      setStatus('Sending…', 'wait');
      try {
        // 1) upload the screenshot FIRST (a failed upload never leaves a dangling pointer).
        //    If the user drew arrows/notes, FLATTEN image+annotations to one PNG; otherwise
        //    upload the base image untouched (no needless re-encode). Flatten is best-effort:
        //    if html2canvas can't run, we still send the un-annotated base image.
        let screenshot_path = null, screenshot_name = null, screenshot_mime = null;
        if (shotBlob) {
          let fileToUpload = shotBlob, upName = shotName || 'screenshot.png', upMime = shotMime || 'image/png';
          if (annoStack.length) {
            setStatus('Flattening your markup…', 'wait');
            try {
              const flat = await flattenStage();
              if (flat) { fileToUpload = flat; upName = 'screenshot.png'; upMime = 'image/png'; }
            } catch (e2) { console.warn('[ReportChange] flatten failed — sending the un-annotated image', e2); }
            setStatus('Sending…', 'wait');
          }
          const id = crypto.randomUUID();
          const ext = (String(upName).split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
          const path = `reports/${id}/screenshot.${ext}`;
          const { error: upErr } = await db.storage.from(BUCKET).upload(path, fileToUpload, { contentType: upMime, upsert: false });
          if (upErr) throw upErr;
          screenshot_path = path;
          screenshot_name = String(upName).slice(0, 200);
          screenshot_mime = upMime;
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
        refreshMine();   // pull the new row into "My requests" (stays pristine → no badge)
        setTimeout(() => { if (modalEl.classList.contains('open')) closeModal(); }, 1100);
      } catch (e) {
        console.error('[ReportChange] submit failed', e);
        const missing = e && /bucket|not found|does not exist/i.test(e.message || '');
        setStatus('Could not send: ' + (e.message || 'unknown error') + (missing ? ' (has the migration been run?)' : ''), 'err');
      } finally {
        busy = false; btn.disabled = false;
      }
    }

    // ── "My requests" (Phase 2): read-only view of the current user's own rows ──
    async function refreshMine() {
      const meId = getEmployeeId();
      if (!meId) return;                       // identity not resolved yet — badge stays hidden
      try {
        const { data, error } = await db.from('change_requests').select('*')
          .eq('submitted_by_id', meId).order('created_at', { ascending: false });
        if (error) { if (!isMissingTable(error)) console.warn('[ReportChange] mine fetch failed', error.message); return; }
        mineRows = data || [];
        updateBadge();
        if (modalEl && modalEl.classList.contains('open') && activeTab === 'mine') renderMine();
      } catch (e) { /* transient — the self-heal tick retries */ }
    }

    function updateBadge() {
      const seen = loadSeen();
      const n = mineRows.filter(r => isUnread(r, seen)).length;
      const paint = (el) => {
        if (!el) return;
        if (n > 0) { el.textContent = n > 9 ? '9+' : String(n); el.style.display = ''; }
        else { el.style.display = 'none'; }
      };
      if (launchBtn) {
        let b = launchBtn.querySelector('.rc-launch-badge');
        if (!b && n > 0) { b = document.createElement('span'); b.className = 'rc-launch-badge'; launchBtn.appendChild(b); }
        paint(b);
      }
      if (modalEl) paint(modalEl.querySelector('.rc-tab-badge'));
    }

    // Opening the list = the user has seen everything currently shown. Rebuild the
    // seen map from the loaded rows (prunes ids no longer theirs), then clear the badge.
    function markMineSeen() {
      const m = {};
      mineRows.forEach(r => { m[r.id] = reqSig(r); });
      saveSeen(m);
      updateBadge();
    }

    function renderMine() {
      const listEl = modalEl && modalEl.querySelector('#rcMineList');
      if (!listEl) return;
      if (!getEmployeeId()) { listEl.innerHTML = '<div class="rc-empty">Sign in to see your requests.</div>'; return; }
      if (!mineRows.length) { listEl.innerHTML = "<div class=\"rc-empty\">You haven't sent any requests yet.</div>"; return; }
      const seen = loadSeen();
      listEl.innerHTML = mineRows.map(r => mineRowHtml(r, isUnread(r, seen))).join('');
      mineRows.forEach(r => wireMineShot(listEl, r));
    }

    function mineRowHtml(r, unread) {
      const type = TYPES.find(t => t.key === r.type) || { emoji: '', label: r.type };
      const prio = PRIORITIES.find(p => p.key === r.priority) || { label: r.priority };
      const prioPill = `<span class="todo-prio-tag todo-prio-tag-${esc(r.priority)}">${esc(prio.label)}</span>`;
      const statusPill = `<span class="rc-status-pill rc-status-${esc(r.status)}">${esc(statusLabel(r.status))}</span>`;
      const newTag = unread ? '<span class="rc-mine-new">Update</span>' : '';
      const update = r.owner_note
        ? `<div class="rc-update"><div class="rc-update-head">Update from the owner${r.owner_note_at ? ' · ' + esc(fmtWhen(r.owner_note_at)) : ''}</div><div class="rc-update-body">${esc(r.owner_note)}</div></div>`
        : '';
      return `<div class="rc-mine-item prio-${esc(r.priority)}${unread ? ' is-unread' : ''}" data-id="${esc(r.id)}">
        <div class="rc-item-top">
          <span class="rc-chip rc-chip-${esc(r.type)}">${type.emoji} ${esc(type.label)}</span>
          ${prioPill}
          ${statusPill}
          ${newTag}
          <span class="rc-item-when">${esc(fmtWhen(r.created_at))}</span>
        </div>
        <div class="rc-item-body${r.body ? '' : ' none'}">${r.body ? esc(r.body) : 'No note — screenshot only.'}</div>
        <div class="rc-shot-slot" data-path="${esc(r.screenshot_path || '')}"></div>
        ${update}
      </div>`;
    }

    async function wireMineShot(listEl, r) {
      const slot = listEl.querySelector(`.rc-mine-item[data-id="${r.id}"] .rc-shot-slot`);
      const path = slot && slot.dataset.path;
      if (!slot || !path) return;
      try {
        let url = mineSigned.get(path);
        if (!url) {
          const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
          if (error) throw error;
          url = data.signedUrl; mineSigned.set(path, url);
        }
        slot.innerHTML = `<a class="rc-shot-thumb" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="screenshot"></a>`;
      } catch (e) { /* leave empty on failure */ }
    }

    // realtime + self-heal for the user's own rows (mirrors the triage channel;
    // separate channel name so the two roles never collide even if co-mounted).
    function resubscribeMine() {
      if (mineChannel) db.removeChannel(mineChannel);
      mineChannel = db.channel('change-requests-mine')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'change_requests' }, () => refreshMine())
        .subscribe();
    }
    function ensureHealthMine() {
      if (!mineChannel || mineChannel.state !== 'joined') resubscribeMine();
      if (document.visibilityState === 'visible') refreshMine();
    }
    function wireSelfHealNetMine() {
      if (mineNetWired) return; mineNetWired = true;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ensureHealthMine(); });
      window.addEventListener('focus', ensureHealthMine);
      setInterval(ensureHealthMine, 60 * 1000);
    }

    injectStyle();
    mountButton();
    resubscribeMine();
    wireSelfHealNetMine();
    // Prime the badge as soon as identity resolves (a few early tries; the 60s
    // self-heal tick keeps it fresh after that).
    [800, 2500, 5000].forEach(ms => setTimeout(refreshMine, ms));
    return { open: openModal, refreshMine };
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
