/* ============================================================
   roadmap.js — shared Owner planning surface, PHASE 1: the roadmap /
   timeline view. Built as a ONE-LINE include so bookkeeping/manager get
   it later with the same 4 lines, no copy-paste drift (deliberately
   NOT the 4-copy shape the To-Do UI has).

   Self-contained: injects its own <style> (everything namespaced .rm-*),
   builds the whole timeline + backlog + add/edit modal inside a mount
   root, owns its own realtime channel. Only reads the board's shared
   design tokens (--accent, --green, --red, --muted, --text, --bg,
   --border, --surface-2) from board-shell.css, with fallbacks.

   Mount (owner board today; same 4 lines on any board later):
     <script src="shared/roadmap.js"></script>
     const roadmap = Roadmap.init({
       db,
       mountSelector: '#roadmap-root',
       getOwnerEmployeeId: () => CURRENT_EMPLOYEE_ID,  // live getter — resolves late
       getName: () => CHAT_IDENTITY.name,
       isSurfaceVisible: () => currentViewKey === 'roadmap',
     });
     VIEW_REFRESH.roadmap = {
       refetch: roadmap.refetch, getChannel: roadmap.getChannel, resubscribe: roadmap.resubscribe,
     };

   Data: migrations/20260727_projects.sql (table `projects`). All queries
   scoped .eq('owner_employee_id', ownerId) — each person's roadmap is
   private (app-level scoping; see the migration's honest caveat).

   RENDER RULES (see also the migration header):
     both dates   -> bar start..target; LATE (red) if target < today and
                     status not in (shipped, parked)
     target only  -> diamond milestone at target; same LATE rule
     start only   -> "running" bar start..today, open/frayed right edge +
                     "no target" chip; ON the timeline, NEVER red (no
                     deadline to miss) — the point is it grows every week
     neither      -> backlog panel (strictly neither-date projects)
   RED is reserved for LATE only; nothing else on the board is red.
   ============================================================ */

window.Roadmap = (function () {
  const STATUSES = [
    { key: 'not_started', label: 'Not started' },
    { key: 'active',      label: 'Active' },
    { key: 'stalled',     label: 'Stalled' },
    { key: 'shipped',     label: 'Shipped' },
    { key: 'parked',      label: 'Parked' },
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.key, s.label]));
  const MIN_QUARTERS = 4;
  const MIN_QUARTER_PX = 130;   // horizontal-scroll floor so quarters never squish to mush
  const MIN_BAR_PCT = 1.2;      // a same-day bar still shows

  let db = null;
  let mountRoot = null;
  let getOwnerId = () => null;
  let getName = () => null;
  let isVisible = () => true;
  let stylesInjected = false;

  let rows = [];                // all projects for this owner (archived included)
  let showArchived = false;
  let channel = null;
  let editingId = null;         // null = create mode
  let didInitialScroll = false;

  // ── helpers ──
  function esc(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ymdToDate(s) {
    if (!s) return null;
    const parts = String(s).slice(0, 10).split('-').map(Number);
    if (parts.length < 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);   // local midnight — no TZ drift
  }
  function dateToYmd(dt) {
    const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, '0'), d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function startOfToday() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function quarterOf(dt) { return Math.floor(dt.getMonth() / 3); }               // 0..3
  function startOfQuarter(dt) { return new Date(dt.getFullYear(), quarterOf(dt) * 3, 1); }
  function addQuarters(dt, n) {
    const idx = dt.getFullYear() * 4 + quarterOf(dt) + n;
    return new Date(Math.floor(idx / 4), (((idx % 4) + 4) % 4) * 3, 1);
  }
  function quartersBetween(a, b) { return (b.getFullYear() - a.getFullYear()) * 4 + (quarterOf(b) - quarterOf(a)); }
  function diffDays(a, b) { return Math.round((b - a) / 86400000); }
  function quarterLabel(dt) { return 'Q' + (quarterOf(dt) + 1) + " '" + String(dt.getFullYear()).slice(2); }
  function fmtDate(dt) { return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

  // Classify one project into how it renders. `today` passed in for consistency.
  function classify(p, today) {
    const start = ymdToDate(p.start_date);
    const target = ymdToDate(p.target_date);
    if (target && start)  return { kind: 'bar',       start, target, right: target };
    if (target && !start) return { kind: 'milestone', start: target, target, right: target };
    if (!target && start) return { kind: 'running',   start, target: null, right: today };
    return { kind: 'backlog', start: null, target: null, right: null };
  }
  function isLate(cls, status, today) {
    if (cls.kind !== 'bar' && cls.kind !== 'milestone') return false;   // running is never "late"
    if (status === 'shipped' || status === 'parked') return false;
    return cls.target < today;
  }

  // ── styles ──
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
:root {
  --rm-grey:#9aa1b0; --rm-active:var(--accent,#5b5ef4); --rm-stalled:#e08a0b;
  --rm-shipped:var(--green,#16a34a); --rm-parked:#64748b; --rm-late:var(--red,#dc2626);
  --rm-line:#334155; --rm-label-w:168px;
}
.rm-wrap { --rm-label-w:168px; }
.rm-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
.rm-toolbar .rm-spacer { flex:1; }
.rm-toggle { display:inline-flex; align-items:center; gap:6px; font-size:0.8rem; color:var(--muted,#6b7280); cursor:pointer; user-select:none; }
.rm-toggle input { margin:0; }

.rm-card { background:#fff; border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:14px 16px; }
.rm-board { display:grid; grid-template-columns:1fr 240px; gap:14px; align-items:start; }
@media (max-width:900px) { .rm-board { grid-template-columns:1fr; } }

.rm-scroll { overflow-x:auto; }
.rm-timeline { position:relative; }
.rm-head { display:flex; height:26px; }
.rm-head-spacer { width:var(--rm-label-w); flex:0 0 var(--rm-label-w); }
.rm-head-track { position:relative; flex:1; }
.rm-q-label { position:absolute; top:2px; transform:translateX(-50%); font-size:0.72rem; font-weight:700; color:var(--muted,#6b7280); white-space:nowrap; }
.rm-q-tick { position:absolute; top:20px; bottom:0; width:1px; }

.rm-body { position:relative; }
.rm-gridlines { position:absolute; top:0; bottom:0; left:var(--rm-label-w); right:0; pointer-events:none; z-index:0; }
.rm-gridline { position:absolute; top:0; bottom:0; width:1px; background:var(--border,#e5e7eb); }
.rm-today { position:absolute; top:0; bottom:0; width:2px; background:var(--rm-line); z-index:3; }
.rm-today-cap { position:absolute; top:-2px; left:50%; transform:translateX(-50%); font-size:0.6rem; font-weight:800; letter-spacing:0.4px; text-transform:uppercase; color:#fff; background:var(--rm-line); border-radius:4px; padding:1px 5px; white-space:nowrap; }

.rm-row { position:relative; display:flex; align-items:center; height:40px; z-index:1; }
.rm-row + .rm-row { border-top:1px dashed #eef0f5; }
.rm-row-label { width:var(--rm-label-w); flex:0 0 var(--rm-label-w); padding-right:12px; font-size:0.82rem; font-weight:600; color:var(--text,#111827); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.rm-row-label:hover { color:var(--accent,#5b5ef4); }
.rm-row.rm-archived { opacity:0.5; }
.rm-track { position:relative; flex:1; height:100%; }

.rm-bar { position:absolute; top:50%; transform:translateY(-50%); height:24px; border-radius:7px; display:flex; align-items:center; gap:6px; padding:0 8px; font-size:0.72rem; font-weight:600; color:#fff; cursor:pointer; overflow:hidden; box-shadow:0 1px 2px rgba(20,30,60,0.12); }
.rm-bar .rm-bar-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rm-st-not_started { background:var(--rm-grey); color:#1f2937; }
.rm-st-active { background:var(--rm-active); }
.rm-st-stalled { background:var(--rm-stalled); }
.rm-st-shipped { background:var(--rm-shipped); }
.rm-st-parked { background:var(--rm-parked); background-image:repeating-linear-gradient(45deg, rgba(255,255,255,0.28) 0, rgba(255,255,255,0.28) 4px, transparent 4px, transparent 9px); }

/* LATE — the one red thing on the board. Solid red, bold outline, chip. */
.rm-bar.rm-late, .rm-marker.rm-late { background:var(--rm-late) !important; background-image:none !important; color:#fff; box-shadow:0 0 0 2px rgba(220,38,38,0.28), 0 1px 3px rgba(220,38,38,0.4); }

/* RUNNING — no target: open/frayed right edge + soft fade. */
.rm-bar.rm-running { border-top-right-radius:0; border-bottom-right-radius:0; -webkit-mask-image:linear-gradient(to right, #000 78%, rgba(0,0,0,0.15) 100%); mask-image:linear-gradient(to right, #000 78%, rgba(0,0,0,0.15) 100%); }
.rm-bar.rm-running::after { content:""; position:absolute; top:0; right:0; bottom:0; width:10px; border-right:2px dashed rgba(255,255,255,0.85); }

.rm-chip { font-size:0.6rem; font-weight:800; letter-spacing:0.3px; text-transform:uppercase; background:rgba(255,255,255,0.25); border-radius:4px; padding:1px 5px; flex:0 0 auto; }

/* MILESTONE — diamond at the target date. */
.rm-marker { position:absolute; top:50%; width:15px; height:15px; transform:translate(-50%,-50%) rotate(45deg); border-radius:3px; cursor:pointer; box-shadow:0 1px 2px rgba(20,30,60,0.2); }
.rm-marker.rm-st-not_started { background:var(--rm-grey); }
.rm-marker.rm-st-active { background:var(--rm-active); }
.rm-marker.rm-st-stalled { background:var(--rm-stalled); }
.rm-marker.rm-st-shipped { background:var(--rm-shipped); }
.rm-marker.rm-st-parked { background:var(--rm-parked); }

.rm-empty { color:var(--muted,#6b7280); font-size:0.82rem; padding:22px; text-align:center; }

/* BACKLOG — strictly neither-date projects. */
.rm-backlog-title { font-size:0.78rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px; color:var(--muted,#6b7280); margin-bottom:10px; }
.rm-backlog-list { display:flex; flex-direction:column; gap:8px; }
.rm-backlog-item { border:1px solid var(--border,#e5e7eb); border-radius:9px; padding:9px 11px; cursor:pointer; background:var(--bg,#f9fafb); }
.rm-backlog-item:hover { border-color:var(--accent,#5b5ef4); }
.rm-backlog-item.rm-archived { opacity:0.5; }
.rm-backlog-name { font-size:0.82rem; font-weight:600; color:var(--text,#111827); overflow-wrap:anywhere; }
.rm-backlog-meta { margin-top:4px; display:flex; align-items:center; gap:6px; }
.rm-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.rm-dot.rm-st-not_started { background:var(--rm-grey); }
.rm-dot.rm-st-active { background:var(--rm-active); }
.rm-dot.rm-st-stalled { background:var(--rm-stalled); }
.rm-dot.rm-st-shipped { background:var(--rm-shipped); }
.rm-dot.rm-st-parked { background:var(--rm-parked); }
.rm-backlog-status { font-size:0.7rem; color:var(--muted,#6b7280); }

/* MODAL — self-styled, light theme to match the board shell. */
.rm-modal { display:none; position:fixed; inset:0; z-index:8000; background:rgba(10,12,20,0.5); align-items:flex-start; justify-content:center; padding:40px 16px; overflow-y:auto; }
.rm-modal.open { display:flex; }
.rm-modal-box { background:#fff; border-radius:14px; width:100%; max-width:460px; padding:20px 22px; box-shadow:0 24px 60px rgba(20,30,60,0.3); }
.rm-modal-title { font-size:1.05rem; font-weight:800; color:var(--text,#111827); margin-bottom:14px; }
.rm-field { margin-bottom:12px; }
.rm-field label { display:block; font-size:0.74rem; font-weight:700; color:var(--muted,#6b7280); text-transform:uppercase; letter-spacing:0.3px; margin-bottom:5px; }
.rm-field input[type=text], .rm-field input[type=date], .rm-field select, .rm-field textarea {
  width:100%; box-sizing:border-box; background:var(--bg,#f9fafb); border:1px solid var(--border,#e5e7eb);
  border-radius:8px; padding:9px 11px; font-size:0.88rem; color:var(--text,#111827); font-family:inherit; outline:none;
}
.rm-field input:focus, .rm-field select:focus, .rm-field textarea:focus { border-color:var(--accent,#5b5ef4); }
.rm-field textarea { resize:vertical; min-height:60px; }
.rm-dates { display:flex; gap:10px; }
.rm-dates .rm-field { flex:1; margin-bottom:0; }
.rm-color-row { display:flex; align-items:center; gap:10px; }
.rm-color-row input[type=color] { width:44px; height:34px; padding:2px; border:1px solid var(--border,#e5e7eb); border-radius:8px; background:#fff; cursor:pointer; }
.rm-color-row label.rm-inline { display:inline-flex; align-items:center; gap:6px; text-transform:none; letter-spacing:0; font-weight:500; font-size:0.8rem; color:var(--text,#111827); margin:0; }
.rm-modal-err { color:var(--red,#dc2626); font-size:0.8rem; min-height:16px; margin:2px 0 8px; }
.rm-modal-actions { display:flex; align-items:center; gap:8px; margin-top:16px; }
.rm-modal-actions .rm-spacer { flex:1; }
.rm-btn { border:none; border-radius:8px; padding:9px 15px; font-size:0.85rem; font-weight:700; cursor:pointer; font-family:inherit; }
.rm-btn-primary { background:var(--accent,#5b5ef4); color:#fff; }
.rm-btn-primary:disabled { opacity:0.55; cursor:default; }
.rm-btn-sec { background:var(--bg,#f9fafb); border:1px solid var(--border,#e5e7eb); color:var(--text,#111827); }
.rm-btn-ghost { background:transparent; color:var(--muted,#6b7280); }
.rm-btn-ghost:hover { color:var(--text,#111827); }
`;
    const style = document.createElement('style');
    style.setAttribute('data-roadmap', '');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── data ──
  async function refetch() {
    const ownerId = getOwnerId();
    if (!mountRoot) return;
    if (!ownerId) {
      renderShell();
      setBoardHTML(`<div class="rm-empty">Could not identify you on this board yet — try reopening it from CrisData.</div>`);
      return;
    }
    try {
      const { data, error } = await db.from('projects')
        .select('*')
        .eq('owner_employee_id', ownerId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      rows = data || [];
      render();
    } catch (err) {
      console.warn('[Roadmap] load failed (migration not run?):', err && err.message);
      renderShell();
      setBoardHTML(`<div class="rm-empty">Run the projects migration to enable the roadmap.</div>`);
    }
  }

  // ── render ──
  function setBoardHTML(html) {
    const board = mountRoot.querySelector('#rm-board-slot');
    if (board) board.innerHTML = html;
  }

  function renderShell() {
    if (mountRoot.querySelector('.rm-wrap')) return;
    mountRoot.innerHTML = `
      <div class="rm-wrap">
        <div class="rm-toolbar">
          <button type="button" class="rm-btn rm-btn-primary" id="rm-new-btn">+ New project</button>
          <span class="rm-spacer"></span>
          <label class="rm-toggle"><input type="checkbox" id="rm-archived-toggle"> Show archived</label>
        </div>
        <div id="rm-board-slot"></div>
      </div>`;
    mountRoot.querySelector('#rm-new-btn').addEventListener('click', () => openModal(null));
    const tog = mountRoot.querySelector('#rm-archived-toggle');
    tog.checked = showArchived;
    tog.addEventListener('change', () => { showArchived = tog.checked; render(); });
    ensureModal();
  }

  function render() {
    renderShell();
    const today = startOfToday();

    const visible = rows.filter(p => showArchived || !p.archived_at);
    const dated = [];
    const backlog = [];
    for (const p of visible) {
      const cls = classify(p, today);
      if (cls.kind === 'backlog') backlog.push(p);
      else dated.push({ p, cls, late: isLate(cls, p.status, today) });
    }
    // Soonest right-edge first -> overdue (target < today) floats to the top.
    dated.sort((a, b) => (a.cls.right - b.cls.right) || (a.p.name || '').localeCompare(b.p.name || ''));

    if (dated.length === 0 && backlog.length === 0) {
      setBoardHTML(`<div class="rm-card"><div class="rm-empty">No projects yet. Hit <strong>+ New project</strong> to start your roadmap.</div></div>`);
      wireItemClicks();
      return;
    }

    // Timeline window: last quarter .. quarter of the latest right-edge, min 4 quarters,
    // and never clip a bar's left edge.
    let winStart, winEnd, spanDays, timelineHTML;
    if (dated.length) {
      let minLeft = addQuarters(today, -1);
      let maxRight = today;
      for (const d of dated) {
        if (d.cls.start < minLeft) minLeft = d.cls.start;
        if (d.cls.right > maxRight) maxRight = d.cls.right;
      }
      winStart = startOfQuarter(minLeft);
      winEnd = addQuarters(startOfQuarter(maxRight), 1);          // exclusive: start of the quarter after
      while (quartersBetween(winStart, winEnd) < MIN_QUARTERS) winEnd = addQuarters(winEnd, 1);
      spanDays = diffDays(winStart, winEnd) || 1;
      const nQuarters = quartersBetween(winStart, winEnd);
      const minWidth = nQuarters * MIN_QUARTER_PX + 168;         // 168 = label col
      const pct = (dt) => (diffDays(winStart, dt) / spanDays) * 100;

      // header labels + ticks, gridlines, today line
      let heads = '', ticks = '', grids = '';
      for (let i = 0; i <= nQuarters; i++) {
        const q = addQuarters(winStart, i);
        const x = pct(q);
        if (i < nQuarters) {
          const mid = (pct(q) + pct(addQuarters(winStart, i + 1))) / 2;
          heads += `<div class="rm-q-label" style="left:${mid}%">${esc(quarterLabel(q))}</div>`;
        }
        if (i > 0 && i < nQuarters) grids += `<div class="rm-gridline" style="left:${x}%"></div>`;
      }
      const todayX = Math.max(0, Math.min(100, pct(today)));

      const rowsHTML = dated.map(({ p, cls, late }) => {
        const st = 'rm-st-' + p.status;
        // Optional per-project color override. LATE red always wins (the .rm-late
        // rule is !important, so it beats this inline background anyway). Guarded
        // to a hex literal so the field can't inject into the style attribute.
        const customBg = (!late && /^#[0-9a-fA-F]{3,8}$/.test(p.color || '')) ? `;background:${p.color}` : '';
        let el = '';
        if (cls.kind === 'milestone') {
          const left = pct(cls.target);
          el = `<div class="rm-marker ${st}${late ? ' rm-late' : ''}" style="left:${left}%${customBg}" title="${esc(fmtDate(cls.target))}"></div>`;
        } else {
          const left = pct(cls.start);
          let width = pct(cls.right) - left;
          if (width < MIN_BAR_PCT) width = MIN_BAR_PCT;
          const running = cls.kind === 'running';
          const chip = late ? '<span class="rm-chip">Late</span>'
            : running ? '<span class="rm-chip">No target</span>' : '';
          const cls2 = `rm-bar ${st}${late ? ' rm-late' : ''}${running ? ' rm-running' : ''}`;
          el = `<div class="${cls2}" style="left:${left}%;width:${width}%${customBg}">`
             + `<span class="rm-bar-name">${esc(p.name)}</span>${chip}</div>`;
        }
        return `<div class="rm-row${p.archived_at ? ' rm-archived' : ''}" data-id="${esc(p.id)}">`
             + `<div class="rm-row-label" title="${esc(p.name)}">${esc(p.name)}</div>`
             + `<div class="rm-track">${el}</div></div>`;
      }).join('');

      timelineHTML = `
        <div class="rm-card">
          <div class="rm-scroll"><div class="rm-timeline" style="min-width:${minWidth}px">
            <div class="rm-head"><div class="rm-head-spacer"></div><div class="rm-head-track">${heads}</div></div>
            <div class="rm-body">
              <div class="rm-gridlines">${grids}<div class="rm-today" style="left:${todayX}%"><span class="rm-today-cap">Today</span></div></div>
              ${rowsHTML}
            </div>
          </div></div>
        </div>`;
    } else {
      timelineHTML = `<div class="rm-card"><div class="rm-empty">Nothing dated yet — every project is in the backlog.</div></div>`;
    }

    // Backlog panel (strictly neither-date)
    const backlogHTML = `
      <div class="rm-card">
        <div class="rm-backlog-title">No date yet (${backlog.length})</div>
        ${backlog.length ? `<div class="rm-backlog-list">${backlog.map(p => `
          <div class="rm-backlog-item${p.archived_at ? ' rm-archived' : ''}" data-id="${esc(p.id)}">
            <div class="rm-backlog-name">${esc(p.name)}</div>
            <div class="rm-backlog-meta"><span class="rm-dot rm-st-${esc(p.status)}"></span><span class="rm-backlog-status">${esc(STATUS_LABEL[p.status] || p.status)}</span></div>
          </div>`).join('')}</div>`
          : `<div class="rm-empty" style="padding:12px">Nothing here.</div>`}
      </div>`;

    setBoardHTML(`<div class="rm-board">${timelineHTML}${backlogHTML}</div>`);
    wireItemClicks();

    // Scroll today into view on first paint of a visible surface (horizontal).
    if (!didInitialScroll && dated.length && isVisible()) {
      const scroller = mountRoot.querySelector('.rm-scroll');
      const tl = mountRoot.querySelector('.rm-timeline');
      if (scroller && tl) {
        const todayEl = tl.querySelector('.rm-today');
        if (todayEl) {
          const target = todayEl.offsetLeft - scroller.clientWidth / 3;
          scroller.scrollLeft = Math.max(0, target);
          didInitialScroll = true;
        }
      }
    }
  }

  function wireItemClicks() {
    mountRoot.querySelectorAll('.rm-row[data-id]').forEach(r =>
      r.addEventListener('click', () => openModal(r.dataset.id)));
    mountRoot.querySelectorAll('.rm-backlog-item[data-id]').forEach(r =>
      r.addEventListener('click', () => openModal(r.dataset.id)));
  }

  // ── modal (create / edit / archive) ──
  function ensureModal() {
    if (document.getElementById('rm-modal')) return;
    const wrap = document.createElement('div');
    wrap.className = 'rm-modal';
    wrap.id = 'rm-modal';
    wrap.innerHTML = `
      <div class="rm-modal-box">
        <div class="rm-modal-title" id="rm-modal-title">New project</div>
        <div class="rm-field"><label>Name</label><input type="text" id="rm-f-name" placeholder="Project name" maxlength="200"></div>
        <div class="rm-field"><label>Status</label><select id="rm-f-status">
          ${STATUSES.map(s => `<option value="${s.key}">${s.label}</option>`).join('')}
        </select></div>
        <div class="rm-dates">
          <div class="rm-field"><label>Start date</label><input type="date" id="rm-f-start"></div>
          <div class="rm-field"><label>Target date</label><input type="date" id="rm-f-target"></div>
        </div>
        <div class="rm-field"><label>Color (optional)</label>
          <div class="rm-color-row">
            <input type="color" id="rm-f-color" value="#5b5ef4">
            <label class="rm-inline"><input type="checkbox" id="rm-f-color-auto" checked> Use status color</label>
          </div>
        </div>
        <div class="rm-field"><label>Notes</label><textarea id="rm-f-notes" placeholder="Optional"></textarea></div>
        <div class="rm-modal-err" id="rm-modal-err"></div>
        <div class="rm-modal-actions">
          <button type="button" class="rm-btn rm-btn-ghost" id="rm-archive-btn" style="display:none"></button>
          <span class="rm-spacer"></span>
          <button type="button" class="rm-btn rm-btn-sec" id="rm-cancel-btn">Cancel</button>
          <button type="button" class="rm-btn rm-btn-primary" id="rm-save-btn">Save</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });
    document.getElementById('rm-cancel-btn').addEventListener('click', closeModal);
    document.getElementById('rm-save-btn').addEventListener('click', saveModal);
    document.getElementById('rm-archive-btn').addEventListener('click', toggleArchiveCurrent);
    // color auto toggle enables/disables the swatch
    const auto = document.getElementById('rm-f-color-auto');
    auto.addEventListener('change', () => { document.getElementById('rm-f-color').disabled = auto.checked; });
  }

  function openModal(id) {
    ensureModal();
    editingId = id || null;
    const p = id ? rows.find(r => String(r.id) === String(id)) : null;
    document.getElementById('rm-modal-title').textContent = p ? 'Edit project' : 'New project';
    document.getElementById('rm-f-name').value = p ? (p.name || '') : '';
    document.getElementById('rm-f-status').value = p ? p.status : 'not_started';
    document.getElementById('rm-f-start').value = p && p.start_date ? String(p.start_date).slice(0, 10) : '';
    document.getElementById('rm-f-target').value = p && p.target_date ? String(p.target_date).slice(0, 10) : '';
    const auto = document.getElementById('rm-f-color-auto');
    const colorEl = document.getElementById('rm-f-color');
    auto.checked = !(p && p.color);
    colorEl.value = (p && p.color) ? p.color : '#5b5ef4';
    colorEl.disabled = auto.checked;
    document.getElementById('rm-f-notes').value = p ? (p.notes || '') : '';
    document.getElementById('rm-modal-err').textContent = '';

    const archiveBtn = document.getElementById('rm-archive-btn');
    if (p) {
      archiveBtn.style.display = '';
      archiveBtn.textContent = p.archived_at ? 'Unarchive' : 'Archive';
    } else {
      archiveBtn.style.display = 'none';
    }
    document.getElementById('rm-modal').classList.add('open');
    setTimeout(() => document.getElementById('rm-f-name').focus(), 30);
  }
  function closeModal() {
    const m = document.getElementById('rm-modal');
    if (m) m.classList.remove('open');
    editingId = null;
  }

  async function saveModal() {
    const ownerId = getOwnerId();
    const err = document.getElementById('rm-modal-err');
    err.textContent = '';
    if (!ownerId) { err.textContent = 'Could not identify you on this board yet.'; return; }

    const name = document.getElementById('rm-f-name').value.trim();
    if (!name) { err.textContent = 'Enter a project name.'; return; }
    const status = document.getElementById('rm-f-status').value;
    const start = document.getElementById('rm-f-start').value || null;
    const target = document.getElementById('rm-f-target').value || null;
    if (start && target && ymdToDate(target) < ymdToDate(start)) {
      err.textContent = 'Target date is before the start date.'; return;
    }
    const auto = document.getElementById('rm-f-color-auto').checked;
    const color = auto ? null : document.getElementById('rm-f-color').value;
    const notes = document.getElementById('rm-f-notes').value.trim() || null;

    const saveBtn = document.getElementById('rm-save-btn');
    saveBtn.disabled = true;
    try {
      if (editingId) {
        const { error } = await db.from('projects')
          .update({ name, status, start_date: start, target_date: target, color, notes })
          .eq('id', editingId);
        if (error) throw error;
      } else {
        const { error } = await db.from('projects').insert({
          owner_employee_id: ownerId, name, status,
          start_date: start, target_date: target, color, notes,
        });
        if (error) throw error;
      }
      closeModal();
      refetch();
    } catch (e) {
      console.error('[Roadmap] save failed', e);
      err.textContent = 'Save failed: ' + ((e && e.message) || 'unknown error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function toggleArchiveCurrent() {
    if (!editingId) return;
    const p = rows.find(r => String(r.id) === String(editingId));
    if (!p) return;
    const archiving = !p.archived_at;
    const err = document.getElementById('rm-modal-err');
    try {
      const { error } = await db.from('projects')
        .update({ archived_at: archiving ? new Date().toISOString() : null })
        .eq('id', editingId);
      if (error) throw error;
      closeModal();
      refetch();
    } catch (e) {
      console.error('[Roadmap] archive failed', e);
      err.textContent = 'Failed: ' + ((e && e.message) || 'unknown error');
    }
  }

  // ── realtime ──
  function resubscribe() {
    if (channel) db.removeChannel(channel);
    channel = db.channel('roadmap-projects-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, refetch)
      .subscribe();
  }
  function getChannel() { return channel; }

  // ── init ──
  function init(config) {
    db = config.db;
    getOwnerId = config.getOwnerEmployeeId || (() => null);
    getName = config.getName || (() => null);
    isVisible = config.isSurfaceVisible || (() => true);
    mountRoot = document.querySelector(config.mountSelector);
    if (!mountRoot) { console.warn('[Roadmap] mount not found:', config.mountSelector); return { refetch: () => {}, getChannel, resubscribe: () => {} }; }
    injectStyles();
    renderShell();
    refetch();
    resubscribe();
    return { refetch, getChannel, resubscribe };
  }

  return { init };
})();
