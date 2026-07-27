/* ============================================================
   planner.js — shared Owner planning surface, PHASE 2 SLICE A: the Planner
   (week calendar + unscheduled inbox rail). One-line include, same shape as
   roadmap.js: self-contained, injects its own <style> (all .pl-*), owns its
   realtime channel, returns a VIEW_REFRESH handle.

   Mount (owner board today; same 4 lines on any board later):
     <script src="shared/planner.js"></script>
     const planner = Planner.init({
       db, mountSelector: '#planner-root',
       getOwnerEmployeeId: () => CURRENT_EMPLOYEE_ID,   // live getter — resolves late
       getName: () => CHAT_IDENTITY.name,
       isSurfaceVisible: () => currentViewKey === 'planner',
     });
     VIEW_REFRESH.planner = { refetch, getChannel, resubscribe };

   Data: migrations/20260727_planning_items.sql. Scoped .eq('owner_employee_id').
   DELIBERATELY separate from `todos`. Reads projects(id,name,color) only for
   coloring — no writes to projects.

   SLICE A scope: no sharing, no @mentions, no notifications, no touching the
   To-Do board. Reference is Sunsama — inbox left, schedule right.

   CAPTURE is the make-or-break interaction; it works from THREE places, all
   title-only + Enter:
     • the pinned rail input (unscheduled)
     • click an empty all-day cell   -> all-day item that day
     • click an empty timed slot      -> item that day at the snapped time

   SCHEDULING: Pointer-Events drag is primary (mouse + touch unified); a tap
   opens the editor whose top row is a first-class quick-schedule picker, so
   planning from a phone never needs a successful drag.
   ============================================================ */

window.Planner = (function () {
  const VISIBLE_DAYS = 3;         // done items linger this long, then drop (mirrors To-Do)
  const HOUR_PX = 44;             // vertical scale of the timed grid
  const VIEW_START_HOUR = 6;      // default scroll lands here (6 AM); grid is full 0–24, scrollable
  const VIEW_END_HOUR = 20;       // 8 PM — sets the default visible height
  const SNAP_MIN = 30;            // drop / click-capture time snap
  const DEFAULT_BLOCK_MIN = 30;   // timed item with no duration
  const DRAG_THRESHOLD = 8;       // px of movement before a press becomes a drag (else = tap)
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];  // Monday-start week

  let db = null, mountRoot = null;
  let getOwnerId = () => null, getName = () => null, isVisible = () => true;
  let stylesInjected = false, shellBuilt = false;

  let items = [];                 // planning_items for this owner within the done-window
  let projectMap = {};            // id -> {name, color}
  let weekStart = mondayOf(todayLocal());
  let showArchived = false;
  let channel = null;
  let editingId = null;
  let drag = null;                // active pointer-drag state

  // ── helpers ──
  function esc(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function todayLocal() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function ymd(dt) {
    const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, '0'), d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function parseYmd(s) {
    if (!s) return null;
    const p = String(s).slice(0, 10).split('-').map(Number);
    return (p.length === 3 && !p.some(isNaN)) ? new Date(p[0], p[1] - 1, p[2]) : null;
  }
  function addDays(dt, n) { const d = new Date(dt); d.setDate(d.getDate() + n); return d; }
  function mondayOf(dt) { const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); const off = (d.getDay() + 6) % 7; return addDays(d, -off); }
  function hmToMin(t) { if (!t) return null; const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
  function minToHM(m) { m = Math.max(0, Math.min(24 * 60 - 1, Math.round(m))); const h = Math.floor(m / 60), mm = m % 60; return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); }
  function snap(m) { return Math.round(m / SNAP_MIN) * SNAP_MIN; }
  function fmtTime(t) {
    const m = hmToMin(t); if (m == null) return '';
    let h = Math.floor(m / 60), mm = m % 60, ap = h < 12 ? 'am' : 'pm';
    h = h % 12; if (h === 0) h = 12;
    return h + (mm ? ':' + String(mm).padStart(2, '0') : '') + ap;
  }
  function projColor(pid) { const p = pid && projectMap[pid]; const c = p && p.color; return /^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : null; }

  // ── styles ──
  function injectStyles() {
    if (stylesInjected) return; stylesInjected = true;
    const css = `
.pl-wrap { --pl-tpl: 48px repeat(7, minmax(0,1fr)); --pl-neutral:#cbd0da; }
.pl-topbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
.pl-nav { display:inline-flex; align-items:center; gap:6px; }
.pl-nav-btn, .pl-today-btn { border:1px solid var(--border,#e5e7eb); background:#fff; color:var(--text,#111827); border-radius:8px; padding:6px 10px; font-size:0.82rem; font-weight:600; cursor:pointer; font-family:inherit; }
.pl-nav-btn:hover, .pl-today-btn:hover { border-color:var(--accent,#5b5ef4); }
.pl-week-label { font-size:0.9rem; font-weight:800; color:var(--text,#111827); min-width:150px; text-align:center; }
.pl-spacer { flex:1; }
.pl-toggle { display:inline-flex; align-items:center; gap:6px; font-size:0.8rem; color:var(--muted,#6b7280); cursor:pointer; user-select:none; }

.pl-body { display:flex; gap:14px; align-items:flex-start; }
@media (max-width:900px) { .pl-body { flex-direction:column; } .pl-rail { width:auto !important; flex:1 1 auto !important; align-self:stretch; } }

.pl-card { background:#fff; border:1px solid var(--border,#e5e7eb); border-radius:12px; }
.pl-rail { width:250px; flex:0 0 250px; padding:12px; box-sizing:border-box; }
.pl-rail-title { font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px; color:var(--muted,#6b7280); margin-bottom:8px; }
.pl-capture { width:100%; box-sizing:border-box; background:var(--bg,#f9fafb); border:1px solid var(--border,#e5e7eb); border-radius:9px; padding:10px 11px; font-size:0.88rem; color:var(--text,#111827); font-family:inherit; outline:none; margin-bottom:10px; }
.pl-capture:focus { border-color:var(--accent,#5b5ef4); background:#fff; }
.pl-rail-list { display:flex; flex-direction:column; gap:7px; }
.pl-rail-empty { color:var(--muted,#6b7280); font-size:0.8rem; line-height:1.5; padding:10px 4px; }
.pl-rail-drop { min-height:40px; border-radius:9px; }

.pl-item { position:relative; border:1px solid var(--border,#e5e7eb); border-left-width:3px; border-radius:9px; background:#fff; padding:8px 10px 8px 11px; display:flex; gap:8px; align-items:flex-start; cursor:pointer; touch-action:none; }
.pl-item:hover { border-color:var(--accent,#5b5ef4); }
.pl-check { margin:1px 0 0; width:15px; height:15px; flex:0 0 auto; cursor:pointer; }
.pl-item-body { min-width:0; flex:1; }
.pl-item-title { font-size:0.83rem; font-weight:600; color:var(--text,#111827); overflow-wrap:anywhere; }
.pl-item-sub { font-size:0.7rem; color:var(--muted,#6b7280); margin-top:2px; }
.pl-item.done .pl-item-title { text-decoration:line-through; color:var(--muted,#6b7280); }
.pl-item.done { opacity:0.65; }

.pl-week { flex:1; min-width:0; padding:0; overflow:hidden; }
.pl-week-head, .pl-week-allday, .pl-week-timed { display:grid; grid-template-columns:var(--pl-tpl); }
.pl-gutter { border-right:1px solid var(--border,#e5e7eb); }
.pl-col-head { padding:8px 6px; text-align:center; border-left:1px solid var(--border,#e5e7eb); }
.pl-col-head .pl-dow { font-size:0.68rem; font-weight:800; text-transform:uppercase; letter-spacing:0.3px; color:var(--muted,#6b7280); }
.pl-col-head .pl-dom { font-size:0.95rem; font-weight:700; color:var(--text,#111827); }
.pl-col-head.pl-today .pl-dom { color:#fff; background:var(--accent,#5b5ef4); border-radius:50%; width:24px; height:24px; line-height:24px; display:inline-block; margin-top:2px; }

.pl-week-allday { border-top:1px solid var(--border,#e5e7eb); border-bottom:1px solid var(--border,#e5e7eb); background:var(--bg,#f9fafb); }
.pl-allday-gutter { border-right:1px solid var(--border,#e5e7eb); font-size:0.58rem; font-weight:700; text-transform:uppercase; color:var(--muted,#6b7280); display:flex; align-items:center; justify-content:center; text-align:center; }
.pl-allday { border-left:1px solid var(--border,#e5e7eb); min-height:34px; padding:4px; display:flex; flex-direction:column; gap:3px; cursor:text; }
.pl-allday-item { border-left-width:3px; }
/* Calendar columns are narrow (down to ~55px on a phone) — titles truncate to a
   single line instead of wrapping per-character; the full title is one tap away. */
.pl-allday-item .pl-item-title { font-size:0.75rem; overflow-wrap:normal; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.pl-week-scroll { max-height:${(VIEW_END_HOUR - VIEW_START_HOUR) * HOUR_PX}px; overflow-y:auto; }
.pl-time-gutter { border-right:1px solid var(--border,#e5e7eb); position:relative; }
.pl-hour-label { position:absolute; right:5px; font-size:0.62rem; color:var(--muted,#6b7280); transform:translateY(-6px); }
.pl-col-timed { position:relative; border-left:1px solid var(--border,#e5e7eb); cursor:text;
  background-image:repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, #eef0f5 ${HOUR_PX - 1}px, #eef0f5 ${HOUR_PX}px); }
.pl-timed-item { position:absolute; box-sizing:border-box; border:1px solid var(--border,#e5e7eb); border-left-width:3px; border-radius:7px; background:#fff; padding:3px 5px; overflow:hidden; cursor:pointer; touch-action:none; box-shadow:0 1px 2px rgba(20,30,60,0.1); }
.pl-timed-item .pl-item-title { font-size:0.72rem; line-height:1.2; overflow-wrap:normal; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pl-timed-item .pl-item-sub { margin-top:1px; }
.pl-timed-item.done { opacity:0.6; }
.pl-timed-item.done .pl-item-title { text-decoration:line-through; }

.pl-drop-hover { outline:2px dashed var(--accent,#5b5ef4); outline-offset:-2px; background:rgba(91,94,244,0.06); }
.pl-ghost { position:fixed; z-index:9000; pointer-events:none; background:#fff; border:1px solid var(--accent,#5b5ef4); border-left-width:3px; border-radius:8px; padding:6px 9px; font-size:0.8rem; font-weight:600; color:var(--text,#111827); box-shadow:0 8px 22px rgba(20,30,60,0.28); max-width:220px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.pl-inline-capture { box-sizing:border-box; border:1px solid var(--accent,#5b5ef4); border-radius:7px; padding:5px 7px; font-size:0.78rem; font-family:inherit; outline:none; width:100%; }
.pl-inline-timed { position:absolute; z-index:20; }

/* mobile floating capture — escapes the ~55px cell so you can see what you type */
.pl-fcap-backdrop { position:fixed; inset:0; z-index:8900; background:rgba(10,12,20,0.18); }
.pl-fcap { position:fixed; left:10px; right:10px; top:10px; z-index:8901; background:#fff; border:1px solid var(--accent,#5b5ef4); border-radius:12px; box-shadow:0 14px 40px rgba(20,30,60,0.3); padding:12px 14px; }
.pl-fcap-ctx { font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.3px; color:var(--muted,#6b7280); margin-bottom:8px; }
.pl-fcap input { width:100%; box-sizing:border-box; border:1px solid var(--border,#e5e7eb); border-radius:9px; padding:11px 12px; font-size:16px; font-family:inherit; outline:none; }
.pl-fcap input:focus { border-color:var(--accent,#5b5ef4); }
.pl-fcap-hint { font-size:0.7rem; color:var(--muted,#6b7280); margin-top:7px; }

/* editor / quick-schedule sheet */
.pl-modal { display:none; position:fixed; inset:0; z-index:8500; background:rgba(10,12,20,0.5); align-items:flex-start; justify-content:center; padding:40px 16px; overflow-y:auto; }
.pl-modal.open { display:flex; }
.pl-modal-box { background:#fff; border-radius:14px; width:100%; max-width:480px; padding:20px 22px; box-shadow:0 24px 60px rgba(20,30,60,0.3); }
.pl-modal-title { font-size:1.05rem; font-weight:800; color:var(--text,#111827); margin-bottom:14px; }
.pl-field { margin-bottom:12px; }
.pl-field label { display:block; font-size:0.72rem; font-weight:700; color:var(--muted,#6b7280); text-transform:uppercase; letter-spacing:0.3px; margin-bottom:5px; }
.pl-field input[type=text], .pl-field input[type=date], .pl-field input[type=time], .pl-field input[type=number], .pl-field select, .pl-field textarea {
  width:100%; box-sizing:border-box; background:var(--bg,#f9fafb); border:1px solid var(--border,#e5e7eb); border-radius:8px; padding:9px 11px; font-size:0.88rem; color:var(--text,#111827); font-family:inherit; outline:none; }
.pl-field textarea { resize:vertical; min-height:54px; }
.pl-field input:focus, .pl-field select:focus, .pl-field textarea:focus { border-color:var(--accent,#5b5ef4); }
.pl-quick { background:var(--bg,#f9fafb); border:1px solid var(--border,#e5e7eb); border-radius:10px; padding:11px 12px; margin-bottom:14px; }
.pl-quick-label { font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.3px; color:var(--muted,#6b7280); margin-bottom:8px; }
.pl-daychips { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:9px; }
.pl-daychip { border:1px solid var(--border,#e5e7eb); background:#fff; border-radius:8px; padding:6px 8px; font-size:0.74rem; font-weight:600; cursor:pointer; color:var(--text,#111827); line-height:1.1; text-align:center; min-width:38px; }
.pl-daychip.active { background:var(--accent,#5b5ef4); color:#fff; border-color:var(--accent,#5b5ef4); }
.pl-daychip.pl-unschedule { color:var(--muted,#6b7280); }
.pl-quick-time { display:flex; gap:8px; align-items:center; }
.pl-quick-time input[type=time], .pl-quick-time input[type=number] { flex:1; box-sizing:border-box; background:#fff; border:1px solid var(--border,#e5e7eb); border-radius:8px; padding:8px 10px; font-size:0.85rem; font-family:inherit; }
.pl-quick-hint { font-size:0.68rem; color:var(--muted,#6b7280); margin-top:6px; }
.pl-two { display:flex; gap:10px; }
.pl-two .pl-field { flex:1; }
.pl-modal-err { color:var(--red,#dc2626); font-size:0.8rem; min-height:16px; margin:2px 0 6px; }
.pl-modal-actions { display:flex; align-items:center; gap:8px; margin-top:14px; }
.pl-btn { border:none; border-radius:8px; padding:9px 15px; font-size:0.85rem; font-weight:700; cursor:pointer; font-family:inherit; }
.pl-btn-primary { background:var(--accent,#5b5ef4); color:#fff; }
.pl-btn-sec { background:var(--bg,#f9fafb); border:1px solid var(--border,#e5e7eb); color:var(--text,#111827); }
.pl-btn-ghost { background:transparent; color:var(--muted,#6b7280); }
.pl-btn-ghost:hover { color:var(--text,#111827); }
.pl-btn-danger { background:transparent; color:var(--red,#dc2626); }
.pl-btn-danger:hover { background:rgba(220,38,38,0.08); }
`;
    const style = document.createElement('style');
    style.setAttribute('data-planner', '');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── data ──
  async function refetch() {
    const ownerId = getOwnerId();
    if (!mountRoot) return;
    buildShell();
    if (!ownerId) { setBody(`<div class="pl-card" style="padding:22px;color:var(--muted)">Could not identify you on this board yet — try reopening it from CrisData.</div>`); return; }
    try {
      const cutoff = new Date(Date.now() - VISIBLE_DAYS * 86400000).toISOString();
      const [it, pr] = await Promise.all([
        db.from('planning_items').select('*').eq('owner_employee_id', ownerId)
          .or(`done_at.is.null,done_at.gte.${cutoff}`).order('created_at', { ascending: true }),
        db.from('projects').select('id,name,color').eq('owner_employee_id', ownerId),
      ]);
      if (it.error) throw it.error;
      items = it.data || [];
      projectMap = {};
      (pr.data || []).forEach(p => { projectMap[p.id] = { name: p.name, color: p.color }; });
      render();
    } catch (err) {
      console.warn('[Planner] load failed (migration not run?):', err && err.message);
      setBody(`<div class="pl-card" style="padding:22px;color:var(--muted)">Run the planning_items migration to enable the Planner.</div>`);
    }
  }

  // ── shell (built once so the pinned capture input keeps focus/value across renders) ──
  function buildShell() {
    if (shellBuilt) return;
    shellBuilt = true;
    mountRoot.innerHTML = `
      <div class="pl-wrap">
        <div class="pl-topbar">
          <div class="pl-nav">
            <button type="button" class="pl-nav-btn" id="pl-prev">‹</button>
            <div class="pl-week-label" id="pl-week-label"></div>
            <button type="button" class="pl-nav-btn" id="pl-next">›</button>
          </div>
          <button type="button" class="pl-today-btn" id="pl-today">Today</button>
          <span class="pl-spacer"></span>
          <label class="pl-toggle"><input type="checkbox" id="pl-archived"> Show archived</label>
        </div>
        <div class="pl-body">
          <div class="pl-card pl-rail">
            <div class="pl-rail-title">Unscheduled</div>
            <input type="text" class="pl-capture" id="pl-capture" placeholder="Capture anything… (Enter)">
            <div class="pl-rail-list pl-rail-drop" id="pl-rail-list" data-drop="rail"></div>
          </div>
          <div class="pl-card pl-week" id="pl-week"></div>
        </div>
      </div>`;
    mountRoot.querySelector('#pl-prev').addEventListener('click', () => { weekStart = addDays(weekStart, -7); render(); });
    mountRoot.querySelector('#pl-next').addEventListener('click', () => { weekStart = addDays(weekStart, 7); render(); });
    mountRoot.querySelector('#pl-today').addEventListener('click', () => { weekStart = mondayOf(todayLocal()); render(); });
    const arch = mountRoot.querySelector('#pl-archived');
    arch.addEventListener('change', () => { showArchived = arch.checked; render(); });
    const cap = mountRoot.querySelector('#pl-capture');
    cap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && cap.value.trim()) { const v = cap.value.trim(); cap.value = ''; createItem({ title: v }); }
    });
    ensureModal();
  }
  function setBody(html) { const w = mountRoot.querySelector('#pl-week'); if (w) w.innerHTML = html; const r = mountRoot.querySelector('#pl-rail-list'); if (r) r.innerHTML = ''; }

  // ── render ──
  function render() {
    buildShell();
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i));
    const visible = items.filter(i => showArchived || !i.archived_at);

    // week label
    const a = days[0], b = days[6];
    const mo = d => d.toLocaleDateString('en-US', { month: 'short' });
    const label = a.getMonth() === b.getMonth()
      ? `${mo(a)} ${a.getDate()} – ${b.getDate()}`
      : `${mo(a)} ${a.getDate()} – ${mo(b)} ${b.getDate()}`;
    mountRoot.querySelector('#pl-week-label').textContent = label;

    // rail (unscheduled)
    const unscheduled = visible.filter(i => !i.scheduled_date);
    const railList = mountRoot.querySelector('#pl-rail-list');
    railList.innerHTML = unscheduled.length
      ? unscheduled.map(i => railCard(i)).join('')
      : `<div class="pl-rail-empty">Nothing waiting. Capture ideas, tasks, notes above — schedule later by dragging onto a day, or tapping to pick one. Living here is fine.</div>`;

    // per-day buckets
    const byDay = days.map(d => {
      const key = ymd(d);
      const dayItems = visible.filter(i => i.scheduled_date === key);
      return { date: d, key, allday: dayItems.filter(i => !i.scheduled_time), timed: dayItems.filter(i => i.scheduled_time) };
    });

    // narrow weekends (Sat idx5, Sun idx6) unless they hold items
    const tpl = ['48px'];
    byDay.forEach((b2, i) => {
      const weekend = (i === 5 || i === 6);
      const has = b2.allday.length || b2.timed.length;
      tpl.push(weekend && !has ? 'minmax(40px,0.5fr)' : 'minmax(0,1fr)');
    });
    mountRoot.querySelector('.pl-wrap').style.setProperty('--pl-tpl', tpl.join(' '));

    // preserve vertical scroll across re-renders
    const prevScroll = mountRoot.querySelector('.pl-week-scroll');
    const savedTop = prevScroll ? prevScroll.scrollTop : (VIEW_START_HOUR * HOUR_PX);
    const todayKey = ymd(todayLocal());

    // head + all-day rows
    let head = `<div class="pl-week-head"><div class="pl-gutter"></div>`;
    byDay.forEach(b2 => {
      const isToday = b2.key === todayKey;
      head += `<div class="pl-col-head${isToday ? ' pl-today' : ''}"><div class="pl-dow">${DAY_NAMES[b2.date.getDay() === 0 ? 6 : b2.date.getDay() - 1]}</div><div class="pl-dom">${b2.date.getDate()}</div></div>`;
    });
    head += `</div>`;

    let allday = `<div class="pl-week-allday"><div class="pl-allday-gutter">All-<br>day</div>`;
    byDay.forEach(b2 => {
      allday += `<div class="pl-allday" data-drop="allday" data-date="${b2.key}">${b2.allday.map(i => alldayCard(i)).join('')}</div>`;
    });
    allday += `</div>`;

    // timed grid (full 0–24, scrollable)
    const gridH = 24 * HOUR_PX;
    let gutter = `<div class="pl-time-gutter" style="height:${gridH}px">`;
    for (let h = 1; h < 24; h++) gutter += `<div class="pl-hour-label" style="top:${h * HOUR_PX}px">${(h % 12) || 12}${h < 12 ? 'a' : 'p'}</div>`;
    gutter += `</div>`;
    let cols = '';
    byDay.forEach(b2 => {
      cols += `<div class="pl-col-timed" data-drop="timed" data-date="${b2.key}" style="height:${gridH}px">${timedCards(b2.timed)}</div>`;
    });
    const timed = `<div class="pl-week-scroll"><div class="pl-week-timed" style="height:${gridH}px">${gutter}${cols}</div></div>`;

    mountRoot.querySelector('#pl-week').innerHTML = head + allday + timed;

    const scroller = mountRoot.querySelector('.pl-week-scroll');
    if (scroller) scroller.scrollTop = savedTop;

    wireItems();
    wireCaptureZones();
  }

  function railCard(i) {
    const col = projColor(i.project_id);
    const proj = i.project_id && projectMap[i.project_id];
    const sub = proj ? esc(proj.name) : '';
    return `<div class="pl-item${i.done_at ? ' done' : ''}" data-id="${esc(i.id)}" style="border-left-color:${col || 'var(--pl-neutral)'}">
      <input type="checkbox" class="pl-check"${i.done_at ? ' checked' : ''}>
      <div class="pl-item-body"><div class="pl-item-title">${esc(i.title)}</div>${sub ? `<div class="pl-item-sub">${sub}</div>` : ''}</div>
    </div>`;
  }
  function alldayCard(i) {
    const col = projColor(i.project_id);
    return `<div class="pl-item pl-allday-item${i.done_at ? ' done' : ''}" data-id="${esc(i.id)}" style="border-left-color:${col || 'var(--pl-neutral)'}">
      <input type="checkbox" class="pl-check"${i.done_at ? ' checked' : ''}>
      <div class="pl-item-body"><div class="pl-item-title">${esc(i.title)}</div></div>
    </div>`;
  }
  function timedCards(list) {
    // greedy lane-packing so overlapping items split the column width instead of hiding
    const arr = list.map(i => {
      const s = hmToMin(i.scheduled_time);
      const e = s + (i.duration_minutes || DEFAULT_BLOCK_MIN);
      return { i, s, e, lane: 0 };
    }).sort((a, b) => a.s - b.s || a.e - b.e);
    const laneEnds = [];
    arr.forEach(a => {
      let placed = false;
      for (let l = 0; l < laneEnds.length; l++) { if (laneEnds[l] <= a.s) { a.lane = l; laneEnds[l] = a.e; placed = true; break; } }
      if (!placed) { a.lane = laneEnds.length; laneEnds.push(a.e); }
    });
    const lanes = laneEnds.length || 1;
    return arr.map(a => {
      const col = projColor(a.i.project_id);
      const top = a.s / 60 * HOUR_PX;
      const height = Math.max((a.e - a.s) / 60 * HOUR_PX, 16);
      const w = 100 / lanes, left = a.lane * w;
      return `<div class="pl-timed-item${a.i.done_at ? ' done' : ''}" data-id="${esc(a.i.id)}"
        style="top:${top}px;height:${height}px;left:calc(${left}% + 1px);width:calc(${w}% - 2px);border-left-color:${col || 'var(--pl-neutral)'}">
        <div class="pl-item-title">${esc(a.i.title)}</div><div class="pl-item-sub">${fmtTime(a.i.scheduled_time)}</div>
      </div>`;
    }).join('');
  }

  // ── item wiring: checkbox toggle, pointer-drag (primary) + tap-to-edit ──
  function wireItems() {
    mountRoot.querySelectorAll('.pl-item, .pl-timed-item').forEach(el => {
      const cb = el.querySelector('.pl-check');
      if (cb) cb.addEventListener('click', (e) => { e.stopPropagation(); toggleDone(el.dataset.id, cb.checked); });
      el.addEventListener('pointerdown', (e) => onItemPointerDown(e, el));
    });
  }
  function onItemPointerDown(e, el) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.pl-check')) return;                // the checkbox handles its own taps
    drag = { id: el.dataset.id, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, hover: null };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }
  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD) {
      drag.moved = true;
      const src = items.find(i => String(i.id) === String(drag.id));
      const g = document.createElement('div');
      g.className = 'pl-ghost'; g.textContent = src ? src.title : '';
      document.body.appendChild(g); drag.ghost = g;
    }
    if (drag.moved) {
      e.preventDefault();
      drag.ghost.style.left = (e.clientX + 12) + 'px';
      drag.ghost.style.top = (e.clientY + 12) + 'px';
      const zone = zoneUnder(e.clientX, e.clientY);
      if (drag.hover !== zone) { if (drag.hover) drag.hover.classList.remove('pl-drop-hover'); if (zone) zone.classList.add('pl-drop-hover'); drag.hover = zone; }
    }
  }
  function onPointerUp(e) {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    if (!drag) return;
    const d = drag; drag = null;
    if (d.ghost) d.ghost.remove();
    if (d.hover) d.hover.classList.remove('pl-drop-hover');
    if (!d.moved) { openEditor(d.id); return; }              // tap → editor (first-class schedule path)
    const zone = zoneUnder(e.clientX, e.clientY);
    if (!zone) return;
    const kind = zone.dataset.drop;
    if (kind === 'rail') applyPatch(d.id, { scheduled_date: null, scheduled_time: null });
    else if (kind === 'allday') applyPatch(d.id, { scheduled_date: zone.dataset.date, scheduled_time: null });
    else if (kind === 'timed') {
      const rect = zone.getBoundingClientRect();
      const min = snap((e.clientY - rect.top) / HOUR_PX * 60);
      applyPatch(d.id, { scheduled_date: zone.dataset.date, scheduled_time: minToHM(min) });
    }
  }
  function zoneUnder(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('[data-drop]') : null;
  }

  // ── click-empty-to-capture: all-day cell + timed slot ──
  function wireCaptureZones() {
    mountRoot.querySelectorAll('.pl-allday').forEach(cell => {
      cell.addEventListener('click', (e) => {
        if (e.target !== cell) return;                        // only the empty background
        openInlineCapture(cell, { date: cell.dataset.date, time: null });
      });
    });
    mountRoot.querySelectorAll('.pl-col-timed').forEach(col => {
      col.addEventListener('click', (e) => {
        if (e.target !== col) return;
        const rect = col.getBoundingClientRect();
        const min = snap((e.clientY - rect.top) / HOUR_PX * 60);
        openInlineCapture(col, { date: col.dataset.date, time: minToHM(min), top: (min / 60 * HOUR_PX) });
      });
    });
  }
  function openInlineCapture(container, ctx) {
    // On a phone the cell is ~55px wide — an in-cell input shows 3-4 chars.
    // Escape to a full-width floating bar (pinned at the top, above the keyboard).
    if (window.matchMedia('(max-width:768px)').matches) { openFloatingCapture(ctx); return; }
    const existing = container.querySelector('.pl-inline-capture');
    if (existing) { existing.focus(); return; }
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'pl-inline-capture' + (ctx.top != null ? ' pl-inline-timed' : '');
    inp.placeholder = ctx.time ? fmtTime(ctx.time) + '…' : 'All-day…';
    if (ctx.top != null) { inp.style.top = ctx.top + 'px'; inp.style.left = '2px'; inp.style.width = 'calc(100% - 4px)'; }
    container.appendChild(inp); inp.focus();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      inp.remove();
      if (save && v) createItem({ title: v, scheduled_date: ctx.date, scheduled_time: ctx.time });
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }
  function openFloatingCapture(ctx) {
    document.querySelectorAll('.pl-fcap, .pl-fcap-backdrop').forEach(n => n.remove());
    const backdrop = document.createElement('div'); backdrop.className = 'pl-fcap-backdrop';
    const bar = document.createElement('div'); bar.className = 'pl-fcap';
    const d = parseYmd(ctx.date);
    const label = (d ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '')
      + (ctx.time ? ' · ' + fmtTime(ctx.time) : ' · all-day');
    bar.innerHTML = `<div class="pl-fcap-ctx">New — ${esc(label)}</div>`
      + `<input type="text" placeholder="Type a title, then Enter…">`
      + `<div class="pl-fcap-hint">Enter to add · Esc / tap away to cancel</div>`;
    document.body.appendChild(backdrop); document.body.appendChild(bar);
    const inp = bar.querySelector('input'); inp.focus();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      backdrop.remove(); bar.remove();
      if (save && v) createItem({ title: v, scheduled_date: ctx.date, scheduled_time: ctx.time });
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    backdrop.addEventListener('click', () => finish(false));
  }

  // ── writes ──
  // Log the WHOLE error (name/message/code/details/hint/stack) + context, so an
  // on-device failure is diagnosable from the console instead of a bare toast.
  // (The "Could not update: TypeError: Load failed" report had no PostgREST code,
  // i.e. a fetch-layer failure — this captures what a recurrence actually is.)
  function logErr(label, error, ctx) {
    console.error(`[Planner] ${label} failed`, Object.assign({
      name: error && error.name, message: error && error.message,
      code: error && error.code, details: error && error.details,
      hint: error && error.hint, stack: error && error.stack,
    }, ctx || {}));
  }
  function describeErr(e) {
    if (!e) return 'unknown error';
    return [e.message, e.code, e.details].filter(Boolean).join(' · ') || String(e);
  }
  // A "Load failed" / "Failed to fetch" is a network-layer TypeError — no PostgREST
  // code. Only these get a single retry, and only for IDEMPOTENT ops (update/delete).
  function isNetworkError(e) { return !!e && !e.code && /load failed|failed to fetch|networkerror/i.test((e && e.message) || ''); }
  async function runIdempotent(label, run, ctx) {
    let { error } = await run();
    if (error && isNetworkError(error)) {
      console.warn(`[Planner] ${label}: network error, retrying once —`, describeErr(error));
      await new Promise(r => setTimeout(r, 300));
      ({ error } = await run());
    }
    if (error) { logErr(label, error, ctx); return error; }
    return null;
  }

  async function createItem(fields) {
    const ownerId = getOwnerId();
    if (!ownerId) return;
    const row = Object.assign({ owner_employee_id: ownerId, title: fields.title, scheduled_date: null, scheduled_time: null }, fields);
    // INSERT is NOT idempotent — never retried (a retry could create a duplicate row).
    const { error } = await db.from('planning_items').insert(row);
    if (error) { logErr('create', error, { row }); alert('Could not add: ' + describeErr(error)); return; }
    refetch();
  }
  async function applyPatch(id, patch) {
    const error = await runIdempotent('update', () => db.from('planning_items').update(patch).eq('id', id), { id, patch });
    if (error) { alert('Could not update: ' + describeErr(error)); return; }
    refetch();
  }
  async function deleteItem(id) {
    if (!confirm('Delete this item? This can\'t be undone.')) return false;
    const error = await runIdempotent('delete', () => db.from('planning_items').delete().eq('id', id), { id });
    if (error) { alert('Could not delete: ' + describeErr(error)); return false; }
    refetch();
    return true;
  }
  async function toggleDone(id, done) {
    await applyPatch(id, { done_at: done ? new Date().toISOString() : null });
  }

  // ── editor / quick-schedule sheet (tap target; first-class scheduling) ──
  function ensureModal() {
    if (document.getElementById('pl-modal')) return;
    const wrap = document.createElement('div');
    wrap.className = 'pl-modal'; wrap.id = 'pl-modal';
    wrap.innerHTML = `
      <div class="pl-modal-box">
        <div class="pl-modal-title">Edit item</div>
        <div class="pl-field"><label>Title</label><input type="text" id="pl-f-title" maxlength="300"></div>
        <div class="pl-quick">
          <div class="pl-quick-label">Schedule</div>
          <div class="pl-daychips" id="pl-daychips"></div>
          <div class="pl-quick-time">
            <input type="time" id="pl-f-time" step="900">
            <input type="number" id="pl-f-dur" min="5" step="5" placeholder="min">
          </div>
          <div class="pl-quick-hint">Pick a day above. Leave time empty for an all-day item. Duration is optional.</div>
        </div>
        <div class="pl-field"><label>Project</label><select id="pl-f-project"></select></div>
        <div class="pl-field"><label>Notes</label><textarea id="pl-f-notes"></textarea></div>
        <div class="pl-modal-err" id="pl-modal-err"></div>
        <div class="pl-modal-actions">
          <button type="button" class="pl-btn pl-btn-danger" id="pl-delete">Delete</button>
          <button type="button" class="pl-btn pl-btn-ghost" id="pl-archive"></button>
          <span class="pl-spacer"></span>
          <button type="button" class="pl-btn pl-btn-sec" id="pl-cancel">Cancel</button>
          <button type="button" class="pl-btn pl-btn-primary" id="pl-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });
    document.getElementById('pl-cancel').addEventListener('click', closeModal);
    document.getElementById('pl-save').addEventListener('click', saveModal);
    document.getElementById('pl-archive').addEventListener('click', toggleArchiveCurrent);
    // Delete = hard delete (with confirm). Archive stays as the secondary "keep it" option.
    document.getElementById('pl-delete').addEventListener('click', async () => {
      if (!editingId) return;
      if (await deleteItem(editingId)) closeModal();
    });
  }
  let pickedDate = null;   // editor's chosen scheduled_date (Y-M-D or null)
  function openEditor(id) {
    ensureModal();
    editingId = id;
    const it = items.find(i => String(i.id) === String(id));
    if (!it) return;
    document.getElementById('pl-f-title').value = it.title || '';
    document.getElementById('pl-f-time').value = it.scheduled_time ? String(it.scheduled_time).slice(0, 5) : '';
    document.getElementById('pl-f-dur').value = it.duration_minutes || '';
    document.getElementById('pl-f-notes').value = it.notes || '';
    pickedDate = it.scheduled_date || null;
    // project select
    const sel = document.getElementById('pl-f-project');
    sel.innerHTML = `<option value="">None</option>` + Object.keys(projectMap)
      .map(pid => `<option value="${esc(pid)}"${it.project_id === pid ? ' selected' : ''}>${esc(projectMap[pid].name)}</option>`).join('');
    // day chips = current displayed week + Unschedule
    const chips = document.getElementById('pl-daychips');
    let html = '';
    for (let i = 0; i < 7; i++) { const d = addDays(weekStart, i); const k = ymd(d); html += `<div class="pl-daychip${pickedDate === k ? ' active' : ''}" data-date="${k}">${DAY_NAMES[i]}<br>${d.getDate()}</div>`; }
    html += `<div class="pl-daychip pl-unschedule${pickedDate === null ? ' active' : ''}" data-date="">Unsched.</div>`;
    chips.innerHTML = html;
    chips.querySelectorAll('.pl-daychip').forEach(c => c.addEventListener('click', () => {
      pickedDate = c.dataset.date || null;
      chips.querySelectorAll('.pl-daychip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
    }));
    const arch = document.getElementById('pl-archive');
    arch.textContent = it.archived_at ? 'Unarchive' : 'Archive';
    document.getElementById('pl-modal-err').textContent = '';
    document.getElementById('pl-modal').classList.add('open');
  }
  function closeModal() { const m = document.getElementById('pl-modal'); if (m) m.classList.remove('open'); editingId = null; }
  async function saveModal() {
    const err = document.getElementById('pl-modal-err'); err.textContent = '';
    const title = document.getElementById('pl-f-title').value.trim();
    if (!title) { err.textContent = 'Enter a title.'; return; }
    const time = document.getElementById('pl-f-time').value || null;   // '' → null (all-day)
    const durRaw = document.getElementById('pl-f-dur').value;
    const dur = durRaw ? Math.max(5, parseInt(durRaw, 10) || 0) : null;
    const project = document.getElementById('pl-f-project').value || null;
    const notes = document.getElementById('pl-f-notes').value.trim() || null;
    // a time only means something with a date — drop it if unscheduled
    const scheduled_time = pickedDate ? time : null;
    const patch = { title, scheduled_date: pickedDate, scheduled_time, duration_minutes: dur, project_id: project, notes };
    const btn = document.getElementById('pl-save'); btn.disabled = true;
    try { await applyPatch(editingId, patch); closeModal(); }
    finally { btn.disabled = false; }
  }
  async function toggleArchiveCurrent() {
    if (!editingId) return;
    const it = items.find(i => String(i.id) === String(editingId));
    if (!it) return;
    await applyPatch(editingId, { archived_at: it.archived_at ? null : new Date().toISOString() });
    closeModal();
  }

  // ── realtime ──
  function resubscribe() {
    if (channel) db.removeChannel(channel);
    channel = db.channel('planner-items-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'planning_items' }, refetch)
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
    if (!mountRoot) { console.warn('[Planner] mount not found:', config.mountSelector); return { refetch: () => {}, getChannel, resubscribe: () => {} }; }
    injectStyles();
    buildShell();
    refetch();
    resubscribe();
    return { refetch, getChannel, resubscribe };
  }

  return { init };
})();
