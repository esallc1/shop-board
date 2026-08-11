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
      @media (max-width: 720px) { .pro-kpis { grid-template-columns: repeat(2, 1fr); } }
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

  // ── per-period KPI computation over closed ROs ──
  // A closed RO counts when its closed_at (bucketed to the shop's calendar day)
  // falls inside the selected range. Sale is real; profit is roGrossProfit.
  function computeKpis(range) {
    const PR = window.PeriodRange;
    const CE = window.CommissionEngine;
    const opts = buildOpts(inputs.packageUnits);

    // lines grouped by RO
    const linesByRo = {};
    (inputs.lines || []).forEach(l => { (linesByRo[l.repair_order_id] = linesByRo[l.repair_order_id] || []).push(l); });

    let sales = 0, profit = 0, roCount = 0;
    (inputs.ros || []).forEach(ro => {
      if (!BILLED_STATUSES.includes(ro.status)) return;
      const day = PR.nyDate(ro.closed_at);              // 'YYYY-MM-DD' in shop tz; null if unstamped
      if (!day || day < range.fromStr || day > range.toStr) return;
      const lines = linesByRo[ro.id] || [];
      sales += roSale(lines);
      profit += CE.roGrossProfit(lines, opts);
      roCount += 1;
    });

    const avgProfit = roCount ? profit / roCount : 0;
    const margin = sales > 0 ? profit / sales : 0;
    return { sales, profit, roCount, avgProfit, margin };
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

    const k = computeKpis(range);
    const presetLabel = preset === 'custom' ? 'Custom range' : PR.labelFor(preset);

    sub.innerHTML =
      `${esc(presetLabel)} · ${esc(PR.fmtRangeLabel(range.start, range.end))} · ${k.roCount} repair order${k.roCount === 1 ? '' : 's'}. ` +
      `Sales are <span class="pro-badge real">REAL</span> · profit is <span class="pro-badge est">ESTIMATED</span> until per-RO costs are confirmed.`;

    if (!k.roCount) {
      body.innerHTML = `<div class="pro-empty">No repair orders were closed in this period.</div>`;
      return;
    }

    const pct = (k.margin * 100);
    const pctStr = (Math.abs(pct) >= 100 ? Math.round(pct) : pct.toFixed(0));
    body.innerHTML = `
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

  async function loadData() {
    loading = true;
    render();
    try {
      const CE = window.CommissionEngine;
      if (!CE || !CE.fetchInputs) throw new Error('CommissionEngine not loaded');
      inputs = await CE.fetchInputs(db);   // { ros, lines, packageUnits, employees } — the canonical fetch
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
