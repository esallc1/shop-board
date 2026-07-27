/* ============================================================
   adoption.js — Owner-board "Feature Adoption" tab. Per person, which
   STAMPED ACTIONS they've done and how long since — so Cris can go ask why
   something isn't landing. A tool for improving what's built, not for
   evaluating people. OWNER BOARD ONLY.

   One-line include, self-contained (.ad-* styles, own mount root), returns a
   VIEW_REFRESH handle. Same shape as roadmap.js / planner.js.
     <script src="shared/adoption.js"></script>
     const adoption = Adoption.init({ db, mountSelector:'#adoption-root', getName, isSurfaceVisible });
     VIEW_REFRESH.adoption = { refetch, getChannel, resubscribe };

   Data: reads TWO things ONCE each (not 10) — the server-side view
   `feature_adoption` (person, metric, event_count, last_touched; see
   migrations/20260727_feature_adoption.sql) and `employees` (roster + role,
   to place people and to show zero-activity people like Cory as all-"never").

   Every chip is labelled by the ACTION the source stamps, never by the
   feature — because a metric only sees ONE attributed write. The blind
   spots (esp. cores counting only RETURNS, not receipt entry) are stated in
   the built-in tip.

   REFRESH: on tab open + the board's visibility hook + a manual button. NO
   realtime, NO polling — getChannel() returns a healthy stub so the board's
   channel-health net never refetches; resubscribe is a no-op.
   ============================================================ */

window.Adoption = (function () {
  // metric -> roles whose BOARD produces that stamped action (derived from write sites)
  const METRIC_ROLES = {
    todo_created:       ['owner', 'manager', 'advisor', 'bookkeeping'],
    todo_completed:     ['owner', 'manager', 'advisor', 'bookkeeping'],
    chat_sent:          ['owner', 'manager', 'advisor', 'bookkeeping'],
    chat_read:          ['owner', 'manager', 'advisor', 'bookkeeping'],
    invoices_captured:  ['advisor', 'bookkeeping'],
    invoices_processed: ['bookkeeping'],
    cores_returned:     ['manager', 'bookkeeping'],
    parts_ordered:      ['advisor'],
    marketing_captured: ['owner', 'manager', 'advisor', 'bookkeeping', 'tech'],  // catch-moment FAB, incl. my-numbers.html
    teardowns_logged:   ['tech'],
    punches:            ['tech'],
  };
  const METRIC_ORDER = ['todo_created', 'todo_completed', 'chat_sent', 'chat_read',
    'invoices_captured', 'invoices_processed', 'cores_returned', 'parts_ordered',
    'marketing_captured', 'teardowns_logged', 'punches'];
  const METRIC_LABEL = {
    todo_created: 'to-dos created', todo_completed: 'to-dos completed',
    chat_sent: 'chat sent', chat_read: 'chat read',
    invoices_captured: 'invoices captured', invoices_processed: 'invoices processed',
    cores_returned: 'cores returned', parts_ordered: 'parts ordered',
    marketing_captured: 'marketing captured', teardowns_logged: 'teardowns', punches: 'clock punches',
  };
  const LOW_CONF = { teardowns_logged: true };   // v1 tool, predates employees table

  const OFFICE_ROLES = ['owner', 'manager', 'advisor', 'bookkeeping'];
  const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', advisor: 'Advisor', bookkeeping: 'Bookkeeping', tech: 'Technician' };
  const ROLE_ORDER = { owner: 0, manager: 1, advisor: 2, bookkeeping: 3, tech: 4 };

  let db = null, mountRoot = null, isVisible = () => true, stylesInjected = false, shellBuilt = false;
  let activity = {};   // person -> metric -> { count, last(Date) }
  let roster = [];     // active employees [{name, role}]
  let asOf = null, loading = false, loadError = false;

  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function daysSince(d) { return d == null ? null : Math.floor((Date.now() - d.getTime()) / 86400000); }
  function colorClass(days) { if (days == null) return 'ad-c-gray'; if (days <= 7) return 'ad-c-green'; if (days <= 29) return 'ad-c-amber'; return 'ad-c-red'; }

  function injectStyles() {
    if (stylesInjected) return; stylesInjected = true;
    const css = `
.ad-wrap { max-width: 1000px; }
.ad-topbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:14px; }
.ad-asof { font-size:0.78rem; color:var(--muted,#6b7280); }
.ad-btn { border:1px solid var(--border,#e5e7eb); background:#fff; color:var(--text,#111827); border-radius:8px; padding:7px 12px; font-size:0.82rem; font-weight:600; cursor:pointer; font-family:inherit; }
.ad-btn:hover { border-color:var(--accent,#5b5ef4); }
.ad-spacer { flex:1; }
.ad-tip-toggle { font-size:0.78rem; color:var(--accent,#5b5ef4); background:none; border:none; cursor:pointer; font-weight:600; font-family:inherit; }
.ad-tip { display:none; background:var(--bg,#f9fafb); border:1px solid var(--border,#e5e7eb); border-radius:10px; padding:13px 15px; margin-bottom:16px; font-size:0.8rem; line-height:1.5; color:var(--text,#111827); }
.ad-tip.open { display:block; }
.ad-tip b { font-weight:700; }
.ad-tip .ad-tip-warn { color:var(--red,#dc2626); }
.ad-tip ul { margin:8px 0 0; padding-left:18px; } .ad-tip li { margin:2px 0; }

.ad-section-label { font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted,#6b7280); margin:6px 0 10px; }
.ad-divider { height:1px; background:var(--border,#e5e7eb); margin:22px 0 18px; }
.ad-row { display:flex; gap:14px; align-items:flex-start; padding:11px 0; border-top:1px solid #eef0f5; }
.ad-row:first-child { border-top:none; }
.ad-person { flex:0 0 150px; min-width:0; }
.ad-person-name { font-size:0.9rem; font-weight:700; color:var(--text,#111827); overflow-wrap:anywhere; }
.ad-person-role { font-size:0.68rem; color:var(--muted,#6b7280); text-transform:uppercase; letter-spacing:0.3px; margin-top:1px; }
.ad-chips { flex:1; display:flex; flex-wrap:wrap; gap:7px; }

.ad-chip { display:inline-flex; align-items:center; gap:5px; font-size:0.74rem; font-weight:600; border-radius:999px; padding:4px 10px; white-space:nowrap; border:1px solid transparent; }
.ad-chip .ad-dot { width:7px; height:7px; border-radius:50%; flex:0 0 auto; }
.ad-c-green { background:#e7f6ec; color:#15803d; } .ad-c-green .ad-dot { background:#16a34a; }
.ad-c-amber { background:#fdf3e3; color:#b45309; } .ad-c-amber .ad-dot { background:#e08a0b; }
.ad-c-red   { background:#fdeaea; color:#b91c1c; } .ad-c-red   .ad-dot { background:#dc2626; }
.ad-c-gray  { background:#f0f1f5; color:#6b7280; } .ad-c-gray  .ad-dot { background:#9aa1b0; }
.ad-lowconf { border-style:dashed; border-color:currentColor; opacity:0.85; }
.ad-lowconf .ad-lc { font-size:0.62rem; opacity:0.8; }

.ad-empty { color:var(--muted,#6b7280); font-size:0.85rem; padding:24px; text-align:center; }
@media (max-width:640px){ .ad-person{ flex-basis:110px; } }
`;
    const st = document.createElement('style'); st.setAttribute('data-adoption', ''); st.textContent = css;
    document.head.appendChild(st);
  }

  function buildShell() {
    if (shellBuilt) return; shellBuilt = true;
    injectStyles();
    mountRoot.innerHTML = `
      <div class="ad-wrap">
        <div class="ad-topbar">
          <button type="button" class="ad-btn" id="ad-refresh">↻ Refresh</button>
          <span class="ad-asof" id="ad-asof"></span>
          <span class="ad-spacer"></span>
          <button type="button" class="ad-tip-toggle" id="ad-tip-toggle">ⓘ What each counts / blind spots</button>
        </div>
        <div class="ad-tip" id="ad-tip">
          Each chip counts ONE <b>stamped action</b> — a write with that person's name on it — and shows days since the last one.
          It does <b>not</b> mean "opened the feature". Reading, scrolling, monitoring panels, and any action the app doesn't
          attribute are invisible here; <b>“never” means “no stamped action”, not “never used it.”</b>
          <ul>
            <li><b>to-dos created / completed</b> — making a to-do / checking one off (not: viewing the list).</li>
            <li><b>chat sent</b> — messages sent. <b>chat read</b> — opening a conversation (marks it read).</li>
            <li><b>invoices captured</b> — uploading an invoice. <b>invoices processed</b> — categorising/posting one.</li>
            <li class="ad-tip-warn"><b>cores returned</b> — ONLY marking a core returned. It does NOT count entering cores from receipts (that insert has no name on it) — so a low/“never” here is a blind spot, not proof of non-use.</li>
            <li><b>parts ordered</b> — creating a parts order. <b>marketing captured</b> — using the “catch this moment” button.</li>
            <li><b>teardowns</b> (marked ≈) — the v1 teardown tool, discontinued; its data predates the employees table — treat as unreliable.</li>
            <li><b>clock punches</b> — clock in/out punches.</li>
          </ul>
        </div>
        <div id="ad-body"><div class="ad-empty">Open to load…</div></div>
      </div>`;
    mountRoot.querySelector('#ad-refresh').addEventListener('click', refetch);
    const tip = mountRoot.querySelector('#ad-tip');
    mountRoot.querySelector('#ad-tip-toggle').addEventListener('click', () => tip.classList.toggle('open'));
  }

  async function refetch() {
    buildShell();
    if (loading) return;
    loading = true; loadError = false;
    const body = mountRoot.querySelector('#ad-body');
    try {
      const [va, em] = await Promise.all([
        db.from('feature_adoption').select('*'),
        db.from('employees').select('name, role, active'),
      ]);
      if (va.error) throw va.error;
      if (em.error) throw em.error;
      activity = {};
      (va.data || []).forEach(r => {
        (activity[r.person] || (activity[r.person] = {}))[r.metric] = { count: r.event_count, last: r.last_touched ? new Date(r.last_touched) : null };
      });
      roster = (em.data || []).filter(e => e.active && ROLE_LABEL[e.role])
        .sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || String(a.name).localeCompare(b.name));
      asOf = new Date();
      render();
    } catch (err) {
      console.warn('[Adoption] load failed (migration not run?):', err && err.message);
      loadError = true;
      if (body) body.innerHTML = `<div class="ad-empty">Couldn't load — run the feature_adoption migration in Supabase, then Refresh.</div>`;
    } finally {
      loading = false;
    }
  }

  function chip(metric, rec) {
    const label = METRIC_LABEL[metric];
    const days = rec ? daysSince(rec.last) : null;
    const cls = colorClass(rec ? days : null);
    const txt = rec ? days + 'd' : 'never';
    const lc = LOW_CONF[metric] ? ' ad-lowconf' : '';
    const lcTag = LOW_CONF[metric] ? '<span class="ad-lc">≈</span>' : '';
    const title = rec ? `${rec.count} event${rec.count === 1 ? '' : 's'} · last ${rec.last ? rec.last.toLocaleString() : '—'}` : 'no stamped action on record';
    return `<span class="ad-chip ${cls}${lc}" title="${esc(title)}"><span class="ad-dot"></span>${lcTag}${esc(label)} · ${txt}</span>`;
  }

  function personRow(emp) {
    const metrics = METRIC_ORDER.filter(m => METRIC_ROLES[m].includes(emp.role));
    const acts = activity[emp.name] || {};
    const chips = metrics.map(m => chip(m, acts[m])).join('');
    return `<div class="ad-row">
      <div class="ad-person"><div class="ad-person-name">${esc(emp.name)}</div><div class="ad-person-role">${esc(ROLE_LABEL[emp.role])}</div></div>
      <div class="ad-chips">${chips || '<span class="ad-empty" style="padding:0">no board features</span>'}</div>
    </div>`;
  }

  function render() {
    const asOfEl = mountRoot.querySelector('#ad-asof');
    if (asOfEl) asOfEl.textContent = asOf ? 'as of ' + asOf.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    const office = roster.filter(e => OFFICE_ROLES.includes(e.role));
    const techs = roster.filter(e => e.role === 'tech');
    let html = '';
    html += `<div class="ad-section-label">Office staff</div>`;
    html += office.length ? office.map(personRow).join('') : '<div class="ad-empty">No office staff.</div>';
    html += `<div class="ad-divider"></div>`;
    html += `<div class="ad-section-label">Technicians</div>`;
    html += techs.length ? techs.map(personRow).join('') : '<div class="ad-empty">No technicians.</div>';
    mountRoot.querySelector('#ad-body').innerHTML = html;
  }

  function init(config) {
    db = config.db;
    isVisible = config.isSurfaceVisible || (() => true);
    mountRoot = document.querySelector(config.mountSelector);
    if (!mountRoot) { console.warn('[Adoption] mount not found:', config.mountSelector); return { refetch: () => {}, getChannel: () => ({ state: 'joined' }), resubscribe: () => {} }; }
    buildShell();
    // No fetch on init — loads on first tab-open (and the board's visibility hook / manual button).
    return {
      refetch,
      getChannel: () => ({ state: 'joined' }),   // healthy stub → board's 60s health net never refetches (no polling)
      resubscribe: () => {},                     // no realtime
    };
  }

  return { init };
})();
