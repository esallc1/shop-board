/* ============================================================================
   shared/profit-by-ro.js — "Profit by RO" (Cost & Profit group, Owner + Bookkeeping).

   PER-JOB profit, NOT realized/paid income. Deliberately DIFFERENT from the
   Bookkeeping "Financial Pulse" (which is cash-basis, gated on paid-in-full).
   Profit by RO is keyed on CLOSED repair orders — repair_orders.closed_at within
   the selected period — and answers "how profitable was the work we billed?":
       RO profit = RO sale − RO cost.

   HONESTY: sale is REAL (sum of the RO's line items, pre-tax). Profit is
   ESTIMATED — per-RO cost reuses the SAME cost logic already live in the Build
   Sheet (Step 2c) / the commission engine: a package line uses its confirmed
   package_units.unit_cost when saved, else the 45%-of-price estimate (the 0.55
   assumed-margin fallback). There is NO parallel cost path here — the per-line
   gross-profit math is CommissionEngine.roGrossProfit.

   STEP A (this file today): rename + shell + period selector (mirrors Financial
   Pulse, default LAST WEEK) + the KPI row on real closed-RO data. The ranked-bar
   per-RO list (Step B) and the donut/split toggle (Step C) are not built yet.

   Framework-free → window.ProfitByRO.mount(container, { db }). Reads only.
   ========================================================================== */
window.ProfitByRO = (function () {
  'use strict';

  const BILLED_STATUSES = ['invoice', 'closed'];   // "billed or closed" — matches the commission engine

  // ── one-time scoped styles ──
  function injectStyles() {
    if (document.getElementById('profitro-styles')) return;
    const el = document.createElement('style');
    el.id = 'profitro-styles';
    el.textContent = `
      .pro-wrap { --pro-real:#15803d; --pro-est:#94a3b8; --pro-warn:#b45309; }
      .pro-head { margin-bottom: 14px; }
      .pro-title { font-size: 1.25rem; font-weight: 750; letter-spacing: -0.01em; color: var(--text); margin: 0; }
      .pro-sub { color: var(--muted); font-size: 0.84rem; margin-top: 5px; line-height: 1.5; }
      .pro-badge { display: inline-block; font-size: 0.64rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; border-radius: 6px; padding: 2px 7px; vertical-align: middle; }
      .pro-badge.real { color: #15803d; background: rgba(21,128,61,0.12); }
      .pro-badge.est  { color: #8a6d1f; background: rgba(230,170,0,0.16); }

      .pro-presets { display: flex; gap: 6px; flex-wrap: wrap; margin: 14px 0 4px; }
      .pro-preset {
        font-size: 0.78rem; font-weight: 600; padding: 6px 12px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--surface); color: var(--muted);
        cursor: pointer; font-family: inherit; transition: border-color .12s, color .12s, background .12s;
      }
      .pro-preset:hover { border-color: var(--accent); color: var(--text); }
      .pro-preset.active { background: var(--accent); border-color: var(--accent); color: #fff; }
      .pro-custom { display: none; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
      .pro-custom.show { display: flex; }
      .pro-custom label { font-size: 0.7rem; color: var(--muted); font-weight: 700; display: flex; align-items: center; gap: 5px; }
      .pro-custom input[type="date"] { padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 0.78rem; color: var(--text); background: var(--surface); }
      .pro-rangelabel { font-size: 0.76rem; color: var(--muted); margin-top: 10px; }

      .pro-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 13px; margin-top: 16px; }
      .pro-tile { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 15px; }
      .pro-tile .pro-lbl { font-size: 0.66rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
      .pro-tile .pro-val { font-size: 1.55rem; font-weight: 750; letter-spacing: -0.02em; margin-top: 8px; line-height: 1; color: var(--text); }
      .pro-tile .pro-val small { font-size: 0.86rem; font-weight: 650; color: var(--text); }
      .pro-tile .pro-ctx { font-size: 0.72rem; margin-top: 7px; }
      .pro-ctx.real { color: var(--pro-real); font-weight: 600; }
      .pro-ctx.est  { color: var(--pro-est); }

      .pro-empty { color: var(--muted); font-size: 0.86rem; padding: 22px 4px; }
      .pro-loading { color: var(--muted); font-size: 0.86rem; padding: 22px 4px; }

      /* Ranked bars — the per-RO list */
      .pro-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border); }
      .pro-ctitle { font-size: 0.98rem; font-weight: 750; color: var(--text); }
      .pro-cap { font-size: 0.76rem; color: var(--muted); margin-top: 3px; }
      .pro-bars { display: flex; flex-direction: column; gap: 10px; margin-top: 15px; }
      .pro-bar { display: grid; grid-template-columns: 150px 1fr 168px; align-items: center; gap: 12px; font-size: 0.82rem; }
      .pro-who { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .pro-who b { font-weight: 700; color: var(--text); }
      .pro-who span { font-size: 0.7rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pro-who span.noadv { color: var(--pro-warn); font-weight: 700; }
      .pro-track { height: 22px; background: var(--surface-2); border-radius: 6px; overflow: hidden; position: relative; }
      .pro-fill { height: 100%; border-radius: 6px; min-width: 2px; }
      .pro-fill.conf { background: #16a34a; }
      .pro-fill.est  { background: #e0a52a; }
      .pro-rt { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
      .pro-rt b { color: var(--text); }
      .pro-rt .m { font-size: 0.74rem; }
      .pro-rt .neg { color: #c0392b; }
      .pro-tail { margin-top: 12px; font-size: 0.78rem; color: var(--muted); border-top: 1px dashed var(--border); padding-top: 11px; }
      .pro-keyline { font-size: 0.74rem; color: var(--muted); margin-top: 15px; display: flex; gap: 16px; flex-wrap: wrap; }
      .pro-keyline span { display: flex; align-items: center; gap: 6px; }
      .pro-cdot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
      .pro-cdot.conf { background: #16a34a; } .pro-cdot.est { background: #e0a52a; }
      .pro-noadv { color: var(--pro-warn); font-weight: 700; }
      .pro-note { background: var(--surface-2); border: 1px dashed var(--border); border-radius: 12px; padding: 11px 14px; margin-top: 15px; font-size: 0.78rem; color: var(--text); line-height: 1.55; }
      .pro-note b { color: var(--text); }

      @media (max-width: 720px) {
        .pro-kpis { grid-template-columns: repeat(2, 1fr); }
        .pro-bar { grid-template-columns: 108px 1fr; grid-template-areas: "who rt" "track track"; row-gap: 6px; }
        .pro-who { grid-area: who; } .pro-rt { grid-area: rt; } .pro-track { grid-area: track; }
      }
    `;
    document.head.appendChild(el);
  }

  // ── formatting ──
  function fmtMoney(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ── the cost/profit opts — reuse the commission engine's fallbacks + rates ──
  // A package line uses its confirmed package_units.unit_cost when saved, else the
  // assumed package margin (default 0.55 → cost = 45% of price). Parts use their
  // real unit_cost or the assumed parts margin. Labor ≈ pure margin; fee /
  // shop_supply / hazmat contribute revenue but no modeled profit. Identical to
  // CommissionEngine.compute — no parallel cost path.
  function buildOpts(packageUnits) {
    const CE = window.CommissionEngine || {};
    const settings = (window.BoardSettings && BoardSettings.getShopSettings) ? BoardSettings.getShopSettings() : {};
    const DPM = CE.DEFAULT_PARTS_MARGIN != null ? CE.DEFAULT_PARTS_MARGIN : 0.40;
    const DKM = CE.DEFAULT_PACKAGE_MARGIN != null ? CE.DEFAULT_PACKAGE_MARGIN : 0.55;
    const opts = {
      partsMarginPct: settings.parts_margin_pct != null ? Number(settings.parts_margin_pct) : DPM,
      packageMarginPct: settings.package_margin_pct != null ? Number(settings.package_margin_pct) : DKM,
      packageCostById: {},
    };
    (packageUnits || []).forEach(u => { if (u && u.unit_cost != null) opts.packageCostById[u.id] = Number(u.unit_cost); });
    return opts;
  }

  // RO sale = Σ(qty × unit_price) over its lines, pre-tax (all line types).
  function roSale(lines) {
    return (lines || []).reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
  }

  // ── state ──
  let db = null;
  let container = null;
  let preset = 'last_week';        // default per spec — most recent completed Sun–Sat
  let customFrom = '', customTo = '';
  let inputs = null;               // cached { ros, lines, packageUnits } from CommissionEngine.fetchInputs
  let loading = false;

  // ── ONE per-RO computation over the closed ROs in range ──
  // A closed RO counts when its closed_at (bucketed to the shop's calendar day)
  // falls inside the range. Both the KPI row and the ranked bars read this same
  // array — there is no second data path. Sale is real; profit is roGrossProfit.
  function computeRows(range) {
    const PR = window.PeriodRange;
    const CE = window.CommissionEngine;
    const opts = buildOpts(inputs.packageUnits);
    const confirmed = opts.packageCostById;             // { package_unit_id → confirmed unit_cost }

    const linesByRo = {};
    (inputs.lines || []).forEach(l => { (linesByRo[l.repair_order_id] = linesByRo[l.repair_order_id] || []).push(l); });
    const empName = {};
    (inputs.employees || []).forEach(e => { empName[e.id] = e.name; });
    const numById = inputs.roNumberById || {};

    const rows = [];
    (inputs.ros || []).forEach(ro => {
      if (!BILLED_STATUSES.includes(ro.status)) return;
      const day = PR.nyDate(ro.closed_at);              // 'YYYY-MM-DD' in shop tz; null if unstamped
      if (!day || day < range.fromStr || day > range.toStr) return;
      const lines = linesByRo[ro.id] || [];
      const sale = roSale(lines);
      const profit = CE.roGrossProfit(lines, opts);
      // Cost basis for the honesty flag: green only if a package (rebuild) line on
      // this RO uses a CONFIRMED unit cost; otherwise the profit rode an estimate.
      let hasConfirmed = false;
      lines.forEach(l => {
        if (l.line_type === 'package' && l.package_unit_id != null && confirmed[l.package_unit_id] != null) hasConfirmed = true;
      });
      const advId = ro.service_writer_id;
      rows.push({
        id: ro.id,
        number: numById[ro.id] != null ? numById[ro.id] : null,
        day,                                            // 'YYYY-MM-DD'
        advisor: advId ? (empName[advId] || null) : null,
        noAdvisor: !advId,
        sale, profit,
        margin: sale > 0 ? profit / sale : 0,
        basis: hasConfirmed ? 'confirmed' : 'estimated',
      });
    });
    return rows;
  }

  // KPI aggregates derived from the SAME per-RO rows.
  function kpisFromRows(rows) {
    const sales = rows.reduce((s, r) => s + r.sale, 0);
    const profit = rows.reduce((s, r) => s + r.profit, 0);
    const roCount = rows.length;
    return { sales, profit, roCount, avgProfit: roCount ? profit / roCount : 0, margin: sales > 0 ? profit / sales : 0 };
  }

  // ── render ──
  function currentRange() {
    return window.PeriodRange.currentRange(preset, { customFrom, customTo });
  }

  function render() {
    if (!container) return;
    const PR = window.PeriodRange;
    const range = currentRange();
    const wrap = container.querySelector('.pro-wrap');
    if (!wrap) return;

    // range control state
    wrap.querySelectorAll('.pro-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === preset));
    wrap.querySelector('.pro-custom').classList.toggle('show', preset === 'custom');
    wrap.querySelector('.pro-rangelabel').textContent = `Showing ${PR.fmtRangeLabel(range.start, range.end)}`;

    const body = wrap.querySelector('.pro-body');
    const sub = wrap.querySelector('.pro-sub');

    if (loading || !inputs) {
      body.innerHTML = `<div class="pro-loading">Loading closed repair orders…</div>`;
      sub.innerHTML = `Per-job profit on repair orders closed in the period.`;
      return;
    }

    const rows = computeRows(range);          // the ONE per-RO dataset
    const k = kpisFromRows(rows);
    const presetLabel = preset === 'custom' ? 'Custom range' : PR.labelFor(preset);

    sub.innerHTML =
      `${esc(presetLabel)} · ${esc(PR.fmtRangeLabel(range.start, range.end))} · ${k.roCount} repair order${k.roCount === 1 ? '' : 's'}. ` +
      `Sales are <span class="pro-badge real">REAL</span> · profit is <span class="pro-badge est">ESTIMATED</span> until per-RO costs are confirmed.`;

    if (!k.roCount) {
      body.innerHTML = `<div class="pro-empty">No repair orders were closed in this period.</div>`;
      return;
    }

    body.innerHTML = kpiRowHtml(k) + rankedBarsHtml(rows);
  }

  // ── KPI row (Step A) ──
  function kpiRowHtml(k) {
    const pct = k.margin * 100;
    const pctStr = (Math.abs(pct) >= 100 ? Math.round(pct) : pct.toFixed(0));
    return `
      <div class="pro-kpis">
        <div class="pro-tile">
          <div class="pro-lbl">Week sales</div>
          <div class="pro-val">${fmtMoney(k.sales)}</div>
          <div class="pro-ctx real">real · pre-tax</div>
        </div>
        <div class="pro-tile">
          <div class="pro-lbl">Est. week profit</div>
          <div class="pro-val">~${fmtMoney(k.profit)}</div>
          <div class="pro-ctx est">estimated cost</div>
        </div>
        <div class="pro-tile">
          <div class="pro-lbl">Avg profit / RO</div>
          <div class="pro-val">~${fmtMoney(k.avgProfit)}</div>
          <div class="pro-ctx est">${k.roCount} RO${k.roCount === 1 ? '' : 's'}</div>
        </div>
        <div class="pro-tile">
          <div class="pro-lbl">Avg margin</div>
          <div class="pro-val">~${pctStr}<small>%</small></div>
          <div class="pro-ctx est">estimated</div>
        </div>
      </div>`;
  }

  // ── ranked bars (Step B) ──
  const numLabel = (r) => (r.number != null ? String(r.number) : '—');
  const mmdd = (day) => (day && day.length >= 10 ? day.slice(5) : (day || ''));  // 'YYYY-MM-DD' → 'MM-DD'
  const marginPct = (m) => `${Math.round(m * 100)}%`;

  function rankedBarsHtml(rows) {
    const sorted = rows.slice().sort((a, b) => b.profit - a.profit);
    const top = sorted.length ? sorted[0].profit : 0;

    // Split the significant earners from the small tail. "Small" = profit at/below
    // 5% of the leader (or ≤ $0); the visible list is also hard-capped so a huge
    // period never prints 40 bars. Always show at least the top 3 if present.
    const CUT = Math.max(1, top * 0.05);
    const MAX_ROWS = 12, MIN_ROWS = 3;
    const visible = [], tail = [];
    sorted.forEach((r, i) => {
      const significant = r.profit > CUT && r.profit > 0;
      if ((significant || visible.length < MIN_ROWS) && visible.length < MAX_ROWS) visible.push(r);
      else tail.push(r);
    });

    const bars = visible.map(r => {
      const w = top > 0 && r.profit > 0 ? Math.max(2, (r.profit / top) * 100) : 0;
      const who = r.noAdvisor
        ? `<span class="noadv">${esc(mmdd(r.day))} · no advisor</span>`
        : `<span>${esc(mmdd(r.day))}${r.advisor ? ' · ' + esc(r.advisor) : ''}</span>`;
      const profStr = r.profit < 0
        ? `<b class="neg">-${fmtMoney(Math.abs(r.profit))}</b>`
        : `<b>${fmtMoney(r.profit)}</b>`;
      return `
        <div class="pro-bar">
          <div class="pro-who"><b>RO ${esc(numLabel(r))}</b>${who}</div>
          <div class="pro-track"><div class="pro-fill ${r.basis === 'confirmed' ? 'conf' : 'est'}" style="width:${w.toFixed(1)}%"></div></div>
          <div class="pro-rt">${profStr} <span class="m">· ${esc(marginPct(r.margin))} · ${fmtMoney(r.sale)}</span></div>
        </div>`;
    }).join('');

    let tailLine = '';
    if (tail.length) {
      const tailMax = tail.reduce((m, r) => Math.max(m, r.profit), 0);
      const nonZero = tail.filter(r => r.profit > 0);
      const zero = tail.filter(r => r.profit <= 0);
      const parts = [];
      if (nonZero.length) parts.push(nonZero.map(numLabel).join(', '));
      if (zero.length) parts.push(`${zero.length} $0 RO${zero.length === 1 ? '' : 's'} (${zero.map(numLabel).join(', ')})`);
      const cap = nonZero.length ? ` (≤ ${fmtMoney(tailMax)} each)` : '';
      tailLine = `<div class="pro-tail">+ ${tail.length} more small RO${tail.length === 1 ? '' : 's'}${cap} — ${esc(parts.join(', and '))}</div>`;
    }

    return `
      <div class="pro-section">
        <div class="pro-ctitle">Repair orders, ranked by profit</div>
        <div class="pro-cap">Biggest earners first. Each RO: sale → estimated cost → profit &amp; margin.</div>
        <div class="pro-bars">${bars}</div>
        ${tailLine}
        <div class="pro-keyline">
          <span><span class="pro-cdot conf"></span>Rebuild line uses confirmed cost</span>
          <span><span class="pro-cdot est"></span>Estimated cost (assumed-margin fallback)</span>
          <span class="pro-noadv">▲ no advisor stamped — wouldn't earn commission</span>
        </div>
        <div class="pro-note"><b>What makes this real:</b> today most ROs' profit rides on an assumed margin. As you confirm each rebuild unit's cost in the Build Sheet — and as jobs get billed on Package lines — the ROs that used those units flip to <b>green (confirmed)</b>, so this board sharpens unit by unit. The last mile (real parts + labor cost per RO) is the per-RO cost feed still to come.</div>
      </div>`;
  }

  async function loadData() {
    loading = true;
    render();
    try {
      const CE = window.CommissionEngine;
      if (!CE || !CE.fetchInputs) throw new Error('CommissionEngine not loaded');
      inputs = await CE.fetchInputs(db);   // { ros, lines, packageUnits, employees } — the canonical fetch
      // Label-only enrichment: the display RO number (ro_number). Profit/sale still
      // come solely from the fetchInputs dataset above — this adds no cost path.
      inputs.roNumberById = {};
      try {
        const nr = await db.from('repair_orders').select('id, ro_number').in('status', BILLED_STATUSES);
        (nr.data || []).forEach(r => { inputs.roNumberById[r.id] = r.ro_number; });
      } catch (e2) { /* numbers fall back to '—' */ }
    } catch (e) {
      console.warn('[ProfitByRO] data load failed', e);
      inputs = { ros: [], lines: [], packageUnits: [] };
    } finally {
      loading = false;
      render();
    }
  }

  function buildShell() {
    injectStyles();
    const PR = window.PeriodRange;
    const presetBtns = PR.PRESETS.map(p =>
      `<button type="button" class="pro-preset" data-preset="${p.key}">${esc(p.label)}</button>`).join('');

    container.innerHTML = `
      <div class="pro-wrap">
        <div class="pro-head">
          <h2 class="pro-title">Profit by RO</h2>
          <div class="pro-sub">Per-job profit on repair orders closed in the period.</div>
        </div>
        <div class="pro-presets">${presetBtns}</div>
        <div class="pro-custom">
          <label>From <input type="date" class="pro-from"></label>
          <label>To <input type="date" class="pro-to"></label>
        </div>
        <div class="pro-rangelabel"></div>
        <div class="pro-body"></div>
      </div>`;

    const wrap = container.querySelector('.pro-wrap');
    wrap.querySelectorAll('.pro-preset').forEach(b => {
      b.addEventListener('click', () => { preset = b.dataset.preset; render(); });
    });
    const from = wrap.querySelector('.pro-from'), to = wrap.querySelector('.pro-to');
    const onCustom = () => { customFrom = from.value; customTo = to.value; preset = 'custom'; render(); };
    from.addEventListener('change', onCustom);
    to.addEventListener('change', onCustom);
  }

  // Public: mount into a container. Idempotent — rebuilds the shell and refetches
  // (fresh closed-RO numbers on each open), matching the Build Sheet's mount model.
  function mount(el, cfg) {
    container = el;
    db = (cfg && cfg.db) || db;
    if (!container || !db) return;
    buildShell();
    render();       // paints the shell + range label immediately
    loadData();     // then fills the KPI row once data lands
  }

  return { mount };
})();
