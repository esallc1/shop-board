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
      .pro-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .pro-ctitle { font-size: 0.98rem; font-weight: 750; color: var(--text); }
      .pro-cap { font-size: 0.76rem; color: var(--muted); margin-top: 3px; }

      /* Graph toggle (Bars | Donut | Split) */
      .pro-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); flex: 0 0 auto; }
      .pro-toggle button { font-size: 0.76rem; font-weight: 650; padding: 5px 12px; border: none; background: transparent; color: var(--muted); cursor: pointer; font-family: inherit; border-left: 1px solid var(--border); }
      .pro-toggle button:first-child { border-left: none; }
      .pro-toggle button:hover { color: var(--text); }
      .pro-toggle button.active { background: var(--accent); color: #fff; }

      /* Donut */
      .pro-donutwrap { display: flex; gap: 26px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
      .pro-donut { flex: 0 0 auto; }
      .pro-leg { display: flex; flex-direction: column; gap: 8px; font-size: 0.82rem; color: var(--text); min-width: 240px; flex: 1; }
      .pro-leg div { display: flex; align-items: center; gap: 9px; }
      .pro-leg .dot { width: 11px; height: 11px; border-radius: 3px; flex: 0 0 auto; }
      .pro-leg .amt { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted); }
      .pro-leg .amt b { color: var(--text); }

      /* Split bar */
      .pro-split { display: flex; height: 40px; border-radius: 9px; overflow: hidden; margin-top: 16px; gap: 2px; background: var(--surface-2); }
      .pro-split .s { display: flex; align-items: center; justify-content: center; color: #fff; font-size: 0.76rem; font-weight: 700; white-space: nowrap; overflow: hidden; }
      .pro-split .s.rebuild { background: #16a34a; }
      .pro-split .s.other { background: #94a3b8; }
      .pro-splitcap { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 12px; font-size: 0.8rem; color: var(--text); }
      .pro-splitcap b { font-variant-numeric: tabular-nums; }
      .pro-splitcap .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: baseline; }
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
  let graphView = 'bars';          // Step C: 'bars' (default) | 'donut' | 'split'

  // Donut slice palette (mirrors the graphs mockup: c1..c4 + a neutral "Other").
  const SLICE_COLORS = ['#6366f1', '#0ea5a4', '#f59e0b', '#ec4899'];
  const OTHER_COLOR = '#cbd5e1';

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
      // Also split out the rebuild (Package-line) profit for the Split view — same
      // per-line engine call, so the Split view has no separate data path.
      let hasConfirmed = false, rebuildProfit = 0;
      lines.forEach(l => {
        if (l.line_type === 'package') {
          rebuildProfit += CE.lineGrossProfit(l, opts);
          if (l.package_unit_id != null && confirmed[l.package_unit_id] != null) hasConfirmed = true;
        }
      });
      const advId = ro.service_writer_id;
      rows.push({
        id: ro.id,
        number: numById[ro.id] != null ? numById[ro.id] : null,
        day,                                            // 'YYYY-MM-DD'
        advisor: advId ? (empName[advId] || null) : null,
        noAdvisor: !advId,
        sale, profit, rebuildProfit,
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

    body.innerHTML = kpiRowHtml(k) + sectionHtml(rows);
    // wire the graph toggle (rebuilt on every render, so re-attach each time)
    body.querySelectorAll('.pro-toggle button').forEach(btn => {
      btn.addEventListener('click', () => {
        if (graphView === btn.dataset.gv) return;
        graphView = btn.dataset.gv;
        render();
      });
    });
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

  // ── shared row helpers ──
  const numLabel = (r) => (r.number != null ? String(r.number) : '—');
  const mmdd = (day) => (day && day.length >= 10 ? day.slice(5) : (day || ''));  // 'YYYY-MM-DD' → 'MM-DD'
  // Margin reads "—" when there's nothing meaningful to divide (no sale, or $0
  // profit) — never a bare 0% and never a divide-by-zero.
  const marginDisplay = (r) => (r.sale > 0 && r.profit !== 0 ? `${Math.round(r.margin * 100)}%` : '—');
  // compact money for the donut center, e.g. $13.5k / $980
  function fmtK(n) {
    n = Number(n) || 0; const a = Math.abs(n);
    if (a >= 1000) return (n < 0 ? '-$' : '$') + (a / 1000).toFixed(a % 1000 < 50 ? 0 : 1) + 'k';
    return (n < 0 ? '-$' : '$') + Math.round(a);
  }

  // The section shell: title + a Bars/Donut/Split toggle, the active graph, then
  // the honesty keyline (bars only) + the standing footnote. All three views read
  // the SAME `rows` (computeRows) — no second data path.
  const CAPTIONS = {
    bars:  'Every closed RO, biggest profit first. Each RO: sale → estimated cost → profit &amp; margin.',
    donut: 'Each slice = that RO’s share of the period’s estimated profit.',
    split: 'Rebuild (Package-line) profit vs everything else.',
  };
  function sectionHtml(rows) {
    const graph = graphView === 'donut' ? donutHtml(rows)
                : graphView === 'split' ? splitHtml(rows)
                : barsHtml(rows);
    const tbtn = (gv, label) => `<button type="button" data-gv="${gv}" class="${graphView === gv ? 'active' : ''}">${label}</button>`;
    const keyline = graphView === 'bars' ? `
        <div class="pro-keyline">
          <span><span class="pro-cdot conf"></span>Rebuild line uses confirmed cost</span>
          <span><span class="pro-cdot est"></span>Estimated cost (assumed-margin fallback)</span>
          <span class="pro-noadv">▲ no advisor stamped — wouldn't earn commission</span>
        </div>` : '';
    return `
      <div class="pro-section">
        <div class="pro-section-head">
          <div>
            <div class="pro-ctitle">Repair orders, ranked by profit</div>
            <div class="pro-cap">${CAPTIONS[graphView] || CAPTIONS.bars}</div>
          </div>
          <div class="pro-toggle">${tbtn('bars', 'Bars')}${tbtn('donut', 'Donut')}${tbtn('split', 'Split')}</div>
        </div>
        <div class="pro-graph">${graph}</div>
        ${keyline}
        <div class="pro-note"><b>What makes this real:</b> today most ROs' profit rides on an assumed margin. As you confirm each rebuild unit's cost in the Build Sheet — and as jobs get billed on Package lines — the ROs that used those units flip to <b>green (confirmed)</b>, so this board sharpens unit by unit. The last mile (real parts + labor cost per RO) is the per-RO cost feed still to come.</div>
      </div>`;
  }

  // ── BARS view (Step B, no collapse — every RO gets a bar) ──
  function barsHtml(rows) {
    const sorted = rows.slice().sort((a, b) => b.profit - a.profit);   // $0/negatives sink to the bottom
    const top = sorted.length ? sorted[0].profit : 0;
    const bars = sorted.map(r => {
      const w = top > 0 && r.profit > 0 ? Math.max(2, (r.profit / top) * 100) : 0;   // $0 → empty bar
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
          <div class="pro-rt">${profStr} <span class="m">· ${esc(marginDisplay(r))} · ${fmtMoney(r.sale)}</span></div>
        </div>`;
    }).join('');
    return `<div class="pro-bars">${bars}</div>`;
  }

  // ── DONUT view (Step C) — share of the period's profit ──
  // Top 4 profitable ROs as slices + an "Other N ROs" slice; center = total. Only
  // positive-profit ROs contribute to a share pie (a slice can't be negative).
  function donutHtml(rows) {
    const pos = rows.filter(r => r.profit > 0).sort((a, b) => b.profit - a.profit);
    const total = pos.reduce((s, r) => s + r.profit, 0);
    if (total <= 0) return `<div class="pro-empty">No positive profit to break down in this period.</div>`;

    const TOPN = 4;
    const head = pos.slice(0, TOPN);
    const rest = pos.slice(TOPN);
    const restSum = rest.reduce((s, r) => s + r.profit, 0);
    const slices = head.map((r, i) => ({ label: `RO ${numLabel(r)}`, value: r.profit, color: SLICE_COLORS[i % SLICE_COLORS.length] }));
    if (rest.length) slices.push({ label: `Other ${rest.length} RO${rest.length === 1 ? '' : 's'}`, value: restSum, color: OTHER_COLOR });

    // hand-rolled SVG donut (same approach as the Financial Pulse donut)
    const cx = 70, cy = 70, r = 52, sw = 22, C = 2 * Math.PI * r;
    let off = 0, arcs = '';
    slices.forEach(s => {
      const len = C * (s.value / total);
      arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(s.label)}: ${fmtMoney(s.value)}</title></circle>`;
      off += len;
    });
    const center = `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="17" font-weight="800" fill="var(--text)">~${esc(fmtK(total))}</text>` +
      `<text x="${cx}" y="${cy + 13}" text-anchor="middle" font-size="7.5" letter-spacing="0.5" fill="var(--muted)">EST. PROFIT</text>`;
    const svg = `<svg viewBox="0 0 140 140" width="180" height="180" role="img" aria-label="Share of profit by RO">${arcs}${center}</svg>`;

    const legend = slices.map(s => {
      const pct = Math.round((s.value / total) * 100);
      return `<div><span class="dot" style="background:${s.color}"></span>${esc(s.label)}<span class="amt"><b>${fmtMoney(s.value)}</b> · ${pct}%</span></div>`;
    }).join('');

    return `<div class="pro-donutwrap"><div class="pro-donut">${svg}</div><div class="pro-leg">${legend}</div></div>`;
  }

  // ── SPLIT view (Step C) — rebuild (Package-line) profit vs everything else ──
  function splitHtml(rows) {
    const rebuild = rows.reduce((s, r) => s + (r.rebuildProfit || 0), 0);
    const total = rows.reduce((s, r) => s + r.profit, 0);
    const other = total - rebuild;
    if (total <= 0) return `<div class="pro-empty">No positive profit to split in this period.</div>`;

    const rPct = Math.max(0, Math.round((rebuild / total) * 100));
    const oPct = Math.max(0, 100 - rPct);
    // labels live inside a segment only when it's wide enough to read; a caption
    // line below always spells both out.
    const rInside = rPct >= 16 ? `Rebuilds · ${fmtMoney(rebuild)} · ${rPct}%` : '';
    const oInside = oPct >= 16 ? `Everything else · ${oPct}%` : '';
    return `
      <div class="pro-split">
        <div class="s rebuild" style="width:${rPct}%">${esc(rInside)}</div>
        <div class="s other" style="width:${oPct}%">${esc(oInside)}</div>
      </div>
      <div class="pro-splitcap">
        <span><span class="sw" style="background:#16a34a"></span>Rebuilds (Package lines): <b>${fmtMoney(Math.max(0, rebuild))}</b> · ${rPct}%</span>
        <span><span class="sw" style="background:#94a3b8"></span>Everything else: <b>${fmtMoney(other)}</b> · ${oPct}%</span>
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
