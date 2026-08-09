// ============================================================
// Build Sheet — the "Cost & Profit" workbench.
//
// A single shared surface mounted on the Owner and Bookkeeping boards under the
// Cost & Profit sidebar group. Inner sub-tab bar with three tabs:
//
//   • Units          — the package_units editor (BoardSettings.renderRebuildUnits,
//                      the ONE shared copy) PLUS, on the Build Sheet only, a
//                      per-unit rebuild-recipe (unit_parts) and live
//                      cost / profit / margin. The cost layer is passed to the
//                      shared editor as an opts.costLayer provider so GM/Advisor
//                      (which never mount the Build Sheet) stay unchanged.
//                      Recipe lines are EITHER standalone typed parts (Step 2a)
//                      OR linked references to a shared library item (Step 2b).
//   • Parts catalog & vendor pricing — the shared parts library (reusable items,
//                      flat or bulk-priced) + the vendor bulk-cost sweep
//                      (raise every part of a vendor by X%, with undo).
//   • People & rates — three shop-level standard-cost rate inputs (Standard R&R
//                      rate, Rebuilder cost, Standard advisor %), saved to
//                      shop_settings. INDEPENDENT of the Advisor Commission engine.
//
// STANDARD COST (per unit):
//   Σ(part cost × qty) + (R&R Hrs × Standard R&R rate) + Rebuilder cost
//     + (Set Price × Standard advisor %)
//   Profit = Set Price − Standard cost ; Margin = Profit ÷ Set Price
// A unit with NO recipe (zero parts) shows an honest "No cost set" — never $0.
// A part's cost is its typed unit_cost (standalone) OR the library item's
// effective per-unit cost (linked): flat = unit_cost, bulk = bulk_price ÷ bulk_qty.
//
// Not here: the Cockpit (Step 3) or a per-person roster / actual-vs-standard
// (Step 3). No feature switch — ships via preview → prod.
//
// Self-contained: injects its own <style> once and relies on BoardSettings
// (loaded on every board) for the Units editor + its shared button styles.
//
// Usage (per board):
//   <div class="view" id="view-buildsheet"><div id="buildsheet-root"></div></div>
//   BuildSheet.mount(document.getElementById('buildsheet-root'), { db });
// mount() is idempotent — the shell is built once; each call re-renders the
// active tab so the numbers reflect the latest data on every open.
// ============================================================

window.BuildSheet = (function () {
  let stylesInjected = false;
  let activeTab = 'units';
  let cfg = null;                 // { db }
  const openPanels = new Map();   // unitId -> result-box element (for live updates)
  let lastSweep = null;           // { changes:[{table,id,field,old}], label } — undo-last

  const TABS = [
    { key: 'units', label: 'Units' },
    { key: 'parts', label: 'Parts catalog & vendor pricing' },
    { key: 'people', label: 'People & rates' },
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtMoney(n) {
    const v = Number(n) || 0;
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(frac) {
    if (frac == null || !Number.isFinite(frac)) return '—';
    return Math.round(frac * 100) + '%';
  }
  function num(v) { const x = parseFloat(v); return Number.isFinite(x) ? x : null; }
  function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .bsheet-tabs {
        display: flex; gap: 2px; flex-wrap: wrap;
        border-bottom: 1px solid var(--border); margin-bottom: 18px;
      }
      .bsheet-tab {
        appearance: none; background: none; border: none; cursor: pointer;
        font-family: inherit; font-size: 0.85rem; color: var(--muted);
        padding: 9px 14px; border-bottom: 2px solid transparent; margin-bottom: -1px;
        white-space: nowrap; transition: color .12s, border-color .12s;
      }
      .bsheet-tab:hover { color: var(--text); }
      .bsheet-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
      .bsheet-tab[disabled] { cursor: default; }
      .bsheet-pane { min-height: 60px; }
      .bsheet-stub {
        color: var(--muted); font-size: 0.9rem; padding: 40px 20px; text-align: center;
        border: 1px dashed var(--border); border-radius: 10px; background: var(--bg);
      }
      .bsheet-stub .bsheet-stub-badge {
        display: inline-block; font-size: 0.68rem; font-weight: 800; text-transform: uppercase;
        letter-spacing: 0.5px; color: var(--accent); background: rgba(91,94,244,0.1);
        border-radius: 20px; padding: 3px 10px; margin-bottom: 10px;
      }

      /* Cost layer — collapsed row summary */
      .cp-nocost { color: var(--muted); font-style: italic; }

      /* Cost layer — expanded recipe panel */
      .cp-recipe { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-top: 2px; }
      .cp-recipe-title { font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); margin-bottom: 8px; }
      .cp-parts { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
      .cp-parts th { text-align: left; color: var(--muted); font-size: 0.68rem; font-weight: 700; padding: 2px 6px; }
      .cp-parts td { padding: 4px 6px; border-top: 1px solid var(--border); vertical-align: middle; }
      .cp-parts input { width: 100%; box-sizing: border-box; padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.78rem; font-family: inherit; color: var(--text); background: #fff; }
      .cp-parts input:focus { outline: none; border-color: var(--accent); }
      .cp-parts .cp-c-cost input, .cp-parts .cp-c-qty input { text-align: right; }
      .cp-parts tfoot td { border-top: 2px solid var(--border); }
      .cp-part-err { color: var(--red, #c0392b); font-size: 0.74rem; margin-top: 6px; min-height: 14px; }
      .cp-link-badge { font-size: 0.72rem; }
      .cp-linked-name { color: var(--text); }
      .cp-linked-name.cp-removed { color: var(--red, #c0392b); font-style: italic; }
      .cp-per { color: var(--muted); font-size: 0.68rem; }
      .cp-addlib { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; font-size: 0.76rem; color: var(--muted); }
      .cp-addlib select, .cp-addlib input { padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.76rem; font-family: inherit; color: var(--text); background: #fff; }
      .cp-addlib select { max-width: 300px; }
      .cp-addlib input { width: 64px; text-align: right; }

      /* Cost layer — result box */
      .cp-result { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 10px; }
      .cp-result-grid { display: grid; grid-template-columns: 1fr auto; gap: 3px 16px; font-size: 0.8rem; max-width: 340px; }
      .cp-result-grid .cp-lbl { color: var(--muted); }
      .cp-result-grid .cp-val { text-align: right; font-variant-numeric: tabular-nums; }
      .cp-result-grid .cp-total { font-weight: 700; border-top: 1px solid var(--border); padding-top: 4px; margin-top: 2px; }
      .cp-result-grid .cp-total.cp-lbl { padding-top: 4px; margin-top: 2px; border-top: 1px solid var(--border); }
      .cp-pos { color: var(--green, #0f6e56); font-weight: 700; }
      .cp-neg { color: var(--red, #c0392b); font-weight: 700; }

      /* People & rates */
      .cp-rates { max-width: 460px; }
      .cp-rate-field { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--border); }
      .cp-rate-field:last-of-type { border-bottom: none; }
      .cp-rate-field .cp-rate-lbl { font-size: 0.88rem; color: var(--text); }
      .cp-rate-field .cp-rate-sub { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
      .cp-rate-field input { width: 120px; text-align: right; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; font-family: inherit; color: var(--text); background: #fff; }
      .cp-rate-field input:focus { outline: none; border-color: var(--accent); }
      .cp-rate-note { font-size: 0.75rem; color: var(--muted); margin: 4px 0 16px; }
      .cp-rate-err { color: var(--red, #c0392b); font-size: 0.78rem; min-height: 16px; margin-top: 8px; }

      /* Parts catalog */
      .cp-cat-section-title { font-size: 0.95rem; font-weight: 700; color: var(--text); margin: 4px 0 3px; }
      .cp-cat-section-sub { font-size: 0.75rem; color: var(--muted); margin: 0 0 14px; }
      .cp-lib-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
      .cp-lib-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: #fff; }
      .cp-lib-top { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .cp-lib-top input, .cp-lib-cost input, .cp-lib-cost select, .cp-lib-top select { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.8rem; font-family: inherit; color: var(--text); background: #fff; }
      .cp-lib-top .cp-lib-name { flex: 1 1 160px; min-width: 120px; }
      .cp-lib-top .cp-lib-pn { flex: 0 1 120px; }
      .cp-lib-top .cp-lib-vendor { flex: 0 1 140px; }
      .cp-lib-cost { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; font-size: 0.8rem; color: var(--muted); }
      .cp-lib-cost input { width: 92px; text-align: right; }
      .cp-lib-cost input.cp-lib-bulkunit { width: 60px; text-align: left; }
      .cp-lib-computed { font-weight: 700; color: var(--text); }
      .cp-lib-actions { display: flex; gap: 8px; margin-top: 10px; }
      .cp-lib-err { color: var(--red, #c0392b); font-size: 0.76rem; margin-top: 6px; min-height: 14px; }
      .cp-lib-empty { color: var(--muted); font-size: 0.82rem; padding: 10px 0; }

      .cp-sweep { border: 1px solid var(--border); border-radius: 10px; padding: 14px; background: var(--bg); margin-top: 6px; }
      .cp-sweep-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .cp-sweep-row select, .cp-sweep-row input { padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.82rem; font-family: inherit; color: var(--text); background: #fff; }
      .cp-sweep-row .cp-sweep-pct { width: 90px; text-align: right; }
      .cp-sweep-summary { font-size: 0.82rem; color: var(--text); margin-top: 10px; min-height: 16px; }
      .cp-sweep-err { color: var(--red, #c0392b); font-size: 0.78rem; margin-top: 6px; min-height: 14px; }
    `;
    document.head.appendChild(style);
  }

  // ── Cost math ────────────────────────────────────────────────
  function partsFor(ctx, unitId) { return (ctx && ctx.partsByUnit.get(String(unitId))) || []; }
  // effective per-unit cost of a library item: flat = unit_cost, bulk = price ÷ qty.
  function libUnitCost(item) {
    if (!item) return 0;
    if (item.cost_mode === 'bulk') { const q = Number(item.bulk_qty) || 0; return q > 0 ? (Number(item.bulk_price) || 0) / q : 0; }
    return Number(item.unit_cost) || 0;
  }
  // the library item a recipe line references (undefined = referenced but missing).
  function linkedItem(part, ctx) {
    if (!part.library_part_id || !ctx) return null;
    return ctx.libraryById.get(String(part.library_part_id));
  }
  function effectiveUnitCost(part, ctx) {
    if (part.library_part_id) { const it = linkedItem(part, ctx); return it ? libUnitCost(it) : 0; }
    return Number(part.unit_cost) || 0;
  }
  function partName(part, ctx) {
    if (part.library_part_id) { const it = linkedItem(part, ctx); return it ? (it.name || '(unnamed)') : '⚠ linked item removed'; }
    return part.name || '(unnamed)';
  }
  function computeCost(live, parts, rates, ctx) {
    const partsCost = parts.reduce((s, p) => s + effectiveUnitCost(p, ctx) * (Number(p.qty) || 0), 0);
    const rrHours = Number(live.default_rr_hours) || 0;
    const rr = rrHours * (Number(rates.std_rr_rate) || 0);
    const rebuild = Number(rates.rebuilder_cost) || 0;
    const advisorPct = Number(rates.std_advisor_pct) || 0;      // percentage number, e.g. 2.5
    const price = Number(live.set_price) || 0;
    const advisor = price * (advisorPct / 100);
    return { partsCost, rrHours, rr, rebuild, advisorPct, advisor, price, total: partsCost + rr + rebuild + advisor };
  }

  // Warm rates + ALL recipe parts + the shared library once.
  async function loadCostContext(db) {
    let rates = { std_advisor_pct: 2.5, std_rr_rate: 0, rebuilder_cost: 0 };
    try {
      if (window.BoardSettings && BoardSettings.reloadShopSettings) await BoardSettings.reloadShopSettings();
      const s = (window.BoardSettings && BoardSettings.getShopSettings) ? BoardSettings.getShopSettings() : {};
      rates = {
        std_advisor_pct: Number(s.std_advisor_pct) || 0,
        std_rr_rate: Number(s.std_rr_rate) || 0,
        rebuilder_cost: Number(s.rebuilder_cost) || 0,
      };
    } catch (e) { console.warn('[BuildSheet] rates load failed', e); }
    const partsByUnit = new Map();
    let tableMissing = false;
    try {
      const { data, error } = await db.from('unit_parts').select('*').order('created_at');
      if (error) throw error;
      (data || []).forEach(p => {
        const k = String(p.package_unit_id);
        if (!partsByUnit.has(k)) partsByUnit.set(k, []);
        partsByUnit.get(k).push(p);
      });
    } catch (e) {
      tableMissing = true;
      console.warn('[BuildSheet] unit_parts not loaded (pre-migration is fine):', e.message || e);
    }
    const libraryById = new Map();
    let libraryList = [];
    let libTableMissing = false;
    try {
      const { data, error } = await db.from('parts_library').select('*').order('name');
      if (error) throw error;
      libraryList = data || [];
      libraryList.forEach(it => libraryById.set(String(it.id), it));
    } catch (e) {
      libTableMissing = true;
      console.warn('[BuildSheet] parts_library not loaded (pre-migration is fine):', e.message || e);
    }
    return { rates, partsByUnit, libraryById, libraryList, tableMissing, libTableMissing, db };
  }

  async function refreshUnitParts(ctx, unitId) {
    try {
      const { data, error } = await ctx.db.from('unit_parts').select('*').eq('package_unit_id', unitId).order('created_at');
      if (error) throw error;
      ctx.partsByUnit.set(String(unitId), data || []);
    } catch (e) { console.warn('[BuildSheet] refresh parts failed', e); }
  }

  // ── Collapsed-row summary ────────────────────────────────────
  function summaryHtml(handle, ctx) {
    if (!ctx) return '<span class="cp-nocost">—</span>';
    const parts = partsFor(ctx, handle.unit.id);
    if (!parts.length) return '<span class="cp-nocost">No cost set</span>';
    const live = handle.getLive();
    const c = computeCost(live, parts, ctx.rates, ctx);
    const profit = c.price - c.total;
    const margin = c.price > 0 ? profit / c.price : null;
    const cls = profit >= 0 ? 'cp-pos' : 'cp-neg';
    return `<span title="Standard cost">${fmtMoney(c.total)}</span> · ` +
      `<span class="${cls}" title="Profit">${fmtMoney(profit)}</span> · ` +
      `<span class="${cls}" title="Margin">${fmtPct(margin)}</span>`;
  }

  // ── Expanded recipe result box ───────────────────────────────
  function resultBoxHtml(handle, ctx) {
    const parts = partsFor(ctx, handle.unit.id);
    const live = handle.getLive();
    if (!parts.length) {
      return `<div class="cp-result"><div class="cp-nocost">No cost set — add a part above to see cost, profit, and margin.</div></div>`;
    }
    const c = computeCost(live, parts, ctx.rates, ctx);
    const profit = c.price - c.total;
    const margin = c.price > 0 ? profit / c.price : null;
    const cls = profit >= 0 ? 'cp-pos' : 'cp-neg';
    const row = (lbl, val, extra) => `<div class="cp-lbl${extra || ''}">${lbl}</div><div class="cp-val${extra || ''}">${val}</div>`;
    return `<div class="cp-result"><div class="cp-result-grid">` +
      row('Parts', fmtMoney(c.partsCost)) +
      row(`R&amp;R (${c.rrHours || 0} hr × ${fmtMoney(ctx.rates.std_rr_rate)})`, fmtMoney(c.rr)) +
      row('Rebuilder', fmtMoney(c.rebuild)) +
      row(`Advisor (${(Number(ctx.rates.std_advisor_pct) || 0)}% of price)`, fmtMoney(c.advisor)) +
      row('Standard cost', fmtMoney(c.total), ' cp-total') +
      row('Set price', fmtMoney(c.price)) +
      `<div class="cp-lbl">Profit</div><div class="cp-val ${cls}">${fmtMoney(profit)}</div>` +
      `<div class="cp-lbl">Margin</div><div class="cp-val ${cls}">${fmtPct(margin)}</div>` +
      `</div></div>`;
  }

  // ── Recipe editor (per unit) ─────────────────────────────────
  function renderRecipe(cell, handle, ctx) {
    if (ctx && ctx.tableMissing) {
      cell.innerHTML = `<div class="cp-recipe"><div class="cp-nocost">Run the <code>unit_parts</code> migration (Cost &amp; Profit Step 2a) to enter parts here.</div></div>`;
      return;
    }
    renderRecipeInner(cell, handle, ctx);
  }

  function renderRecipeInner(cell, handle, ctx) {
    const unitId = String(handle.unit.id);
    const parts = partsFor(ctx, unitId);

    const standaloneRow = (p) => `
      <tr data-pid="${esc(p.id)}">
        <td><input type="text" data-pf="name" value="${esc(p.name || '')}" placeholder="part name"></td>
        <td><input type="text" data-pf="part_no" value="${esc(p.part_no || '')}" placeholder="part #"></td>
        <td><input type="text" data-pf="vendor" value="${esc(p.vendor || '')}" placeholder="vendor"></td>
        <td class="cp-c-cost"><input type="number" data-pf="unit_cost" min="0" step="0.01" value="${p.unit_cost != null ? esc(String(p.unit_cost)) : ''}" placeholder="0.00"></td>
        <td class="cp-c-qty"><input type="number" data-pf="qty" min="0" step="1" value="${p.qty != null ? esc(String(p.qty)) : ''}" placeholder="1"></td>
        <td style="white-space:nowrap">
          <button type="button" class="stgfeat-btn" data-pact="save" style="padding:2px 8px;font-size:0.7rem">Save</button>
          <button type="button" class="stgfeat-btn" data-pact="del" style="padding:2px 8px;font-size:0.7rem">✕</button>
        </td>
      </tr>`;
    const linkedRow = (p) => {
      const it = linkedItem(p, ctx);
      const removed = !it;
      const per = it && it.cost_mode === 'bulk' ? ` <span class="cp-per">/${esc(it.bulk_unit || 'unit')}</span>` : '';
      return `
      <tr data-pid="${esc(p.id)}" data-linked="1">
        <td><span class="cp-link-badge" title="Linked to the shared parts library">📚</span> <span class="cp-linked-name${removed ? ' cp-removed' : ''}">${esc(partName(p, ctx))}</span></td>
        <td>${esc(it ? (it.part_no || '') : '')}</td>
        <td>${esc(it ? (it.vendor || '') : '')}</td>
        <td class="cp-c-cost" style="text-align:right">${fmtMoney(effectiveUnitCost(p, ctx))}${per}</td>
        <td class="cp-c-qty"><input type="number" data-pf="qty" min="0" step="1" value="${p.qty != null ? esc(String(p.qty)) : ''}" placeholder="1"></td>
        <td style="white-space:nowrap">
          <button type="button" class="stgfeat-btn" data-pact="save" style="padding:2px 8px;font-size:0.7rem">Save</button>
          <button type="button" class="stgfeat-btn" data-pact="del" style="padding:2px 8px;font-size:0.7rem">✕</button>
        </td>
      </tr>`;
    };
    const bodyRows = parts.length
      ? parts.map(p => (p.library_part_id ? linkedRow(p) : standaloneRow(p))).join('')
      : '<tr><td colspan="6" style="color:var(--muted);padding:6px">No parts yet — add the first line below.</td></tr>';

    // "Add from library" control — only when the library table exists + has items.
    let addLibHtml = '';
    if (!ctx.libTableMissing) {
      if (ctx.libraryList.length) {
        const opts = ctx.libraryList.map(it =>
          `<option value="${esc(it.id)}">${esc(it.name || '(unnamed)')}${it.vendor ? ' — ' + esc(it.vendor) : ''} (${fmtMoney(libUnitCost(it))}${it.cost_mode === 'bulk' ? '/' + esc(it.bulk_unit || 'unit') : ''})</option>`
        ).join('');
        addLibHtml =
          `<div class="cp-addlib">
            <span>Add from library:</span>
            <select data-libsel>${opts}</select>
            <input type="number" data-libqty min="0" step="1" placeholder="qty">
            <button type="button" class="stgfeat-btn" data-libadd style="padding:3px 8px;font-size:0.72rem">Add</button>
          </div>`;
      } else {
        addLibHtml = `<div class="cp-addlib">No library items yet — add reusable parts on the <strong>Parts catalog &amp; vendor pricing</strong> tab.</div>`;
      }
    }

    cell.innerHTML =
      `<div class="cp-recipe">
        <div class="cp-recipe-title">Rebuild recipe — ${esc(handle.unit.unit_code || 'unit')}</div>
        <table class="cp-parts">
          <thead><tr><th>Part</th><th>Part #</th><th>Vendor</th><th style="text-align:right">Cost $</th><th style="text-align:right">Qty</th><th></th></tr></thead>
          <tbody>${bodyRows}</tbody>
          <tfoot><tr>
            <td><input type="text" data-nf="name" placeholder="part name"></td>
            <td><input type="text" data-nf="part_no" placeholder="part #"></td>
            <td><input type="text" data-nf="vendor" placeholder="vendor"></td>
            <td class="cp-c-cost"><input type="number" data-nf="unit_cost" min="0" step="0.01" placeholder="0.00"></td>
            <td class="cp-c-qty"><input type="number" data-nf="qty" min="0" step="1" placeholder="1"></td>
            <td><button type="button" class="stgfeat-btn" data-nadd style="padding:2px 8px;font-size:0.7rem">Add</button></td>
          </tr></tfoot>
        </table>
        ${addLibHtml}
        <div class="cp-part-err" data-perr></div>
        <div data-resultbox></div>
      </div>`;

    const resultBox = cell.querySelector('[data-resultbox]');
    resultBox.innerHTML = resultBoxHtml(handle, ctx);
    openPanels.set(unitId, resultBox);

    const errEl = cell.querySelector('[data-perr]');
    const fail = (m) => { if (errEl) errEl.textContent = m || ''; };
    const isMissingCol = (e) => e && (e.code === '42P01' || e.code === 'PGRST204' || /relation|column|does not exist/i.test(e.message || ''));

    const refresh = async () => {
      await refreshUnitParts(ctx, unitId);
      renderRecipeInner(cell, handle, ctx);
      try { handle.setSummary(summaryHtml(handle, ctx)); } catch (e) {}
    };

    // add standalone typed part
    cell.querySelector('[data-nadd]').addEventListener('click', async () => {
      fail('');
      const g = (sel) => cell.querySelector(`[data-nf="${sel}"]`).value;
      const name = (g('name') || '').trim();
      const unit_cost = num(g('unit_cost'));
      const qtyRaw = num(g('qty'));
      if (!name) { fail('Enter a part name.'); return; }
      if (unit_cost != null && unit_cost < 0) { fail('Cost cannot be negative.'); return; }
      const qty = qtyRaw == null ? 1 : qtyRaw;
      if (qty < 0) { fail('Qty cannot be negative.'); return; }
      const { error } = await ctx.db.from('unit_parts').insert({
        package_unit_id: unitId, name, part_no: (g('part_no') || '').trim() || null,
        vendor: (g('vendor') || '').trim() || null, unit_cost: unit_cost == null ? 0 : unit_cost, qty,
      });
      if (error) { fail(isMissingCol(error) ? 'Run the unit_parts migration (Step 2a) first.' : 'Add failed: ' + error.message); return; }
      await refresh();
    });

    // add linked library line
    const libAddBtn = cell.querySelector('[data-libadd]');
    if (libAddBtn) libAddBtn.addEventListener('click', async () => {
      fail('');
      const sel = cell.querySelector('[data-libsel]');
      const libId = sel && sel.value;
      if (!libId) { fail('Pick a library item.'); return; }
      const qtyRaw = num(cell.querySelector('[data-libqty]').value);
      const qty = qtyRaw == null ? 1 : qtyRaw;
      if (qty < 0) { fail('Qty cannot be negative.'); return; }
      const { error } = await ctx.db.from('unit_parts').insert({ package_unit_id: unitId, library_part_id: libId, qty });
      if (error) { fail(isMissingCol(error) ? 'Run the parts_library migration (Step 2b) first.' : 'Add failed: ' + error.message); return; }
      await refresh();
    });

    // per-row save / delete (standalone edits everything; linked edits qty only)
    cell.querySelectorAll('tr[data-pid]').forEach(tr => {
      tr.querySelector('[data-pact="save"]').addEventListener('click', async () => {
        fail('');
        const linked = tr.dataset.linked === '1';
        let update;
        if (linked) {
          const qty = num(tr.querySelector('[data-pf="qty"]').value);
          update = { qty: qty == null ? 1 : qty };
        } else {
          const g = (sel) => tr.querySelector(`[data-pf="${sel}"]`).value;
          const name = (g('name') || '').trim();
          if (!name) { fail('Part name cannot be empty.'); return; }
          const unit_cost = num(g('unit_cost'));
          const qty = num(g('qty'));
          update = {
            name, part_no: (g('part_no') || '').trim() || null, vendor: (g('vendor') || '').trim() || null,
            unit_cost: unit_cost == null ? 0 : unit_cost, qty: qty == null ? 1 : qty,
          };
        }
        const { error } = await ctx.db.from('unit_parts').update(update).eq('id', tr.dataset.pid);
        if (error) { fail('Save failed: ' + error.message); return; }
        const btn = tr.querySelector('[data-pact="save"]');
        if (btn) { const o = btn.textContent; btn.textContent = 'Saved'; setTimeout(() => { if (btn.isConnected) btn.textContent = o; }, 900); }
        await refresh();
      });
      tr.querySelector('[data-pact="del"]').addEventListener('click', async () => {
        fail('');
        const nm = (tr.querySelector('.cp-linked-name') || tr.querySelector('[data-pf="name"]') || {}).textContent
          || (tr.querySelector('[data-pf="name"]') || {}).value || 'this part';
        if (!confirm('Delete "' + nm + '" from this recipe?')) return;
        const { error } = await ctx.db.from('unit_parts').delete().eq('id', tr.dataset.pid);
        if (error) { fail('Delete failed: ' + error.message); return; }
        await refresh();
      });
    });
  }

  // Called by the shared editor when Set Price / R&R Hrs are typed on the row.
  function onRowInput(handle, ctx) {
    if (!ctx) return;
    try { handle.setSummary(summaryHtml(handle, ctx)); } catch (e) {}
    const box = openPanels.get(String(handle.unit.id));
    if (box) box.innerHTML = resultBoxHtml(handle, ctx);
  }
  function onCollapse(handle) { openPanels.delete(String(handle.unit.id)); }

  function makeCostLayer(db) {
    return {
      load: () => loadCostContext(db),
      summaryHtml: (handle, ctx) => summaryHtml(handle, ctx),
      renderRecipe: (cell, handle, ctx) => renderRecipe(cell, handle, ctx),
      onRowInput: (handle, ctx) => onRowInput(handle, ctx),
      onCollapse: (handle) => onCollapse(handle),
    };
  }

  // ── Parts catalog & vendor pricing tab ───────────────────────
  async function renderPartsCatalog(pane) {
    pane.innerHTML = '<div class="bsheet-stub">Loading…</div>';
    const db = cfg.db;
    let items = null;
    try {
      const { data, error } = await db.from('parts_library').select('*').order('name');
      if (error) throw error;
      items = data || [];
    } catch (e) {
      pane.innerHTML = `<div class="bsheet-stub"><div class="bsheet-stub-badge">Step 2b</div><div>Run the <code>parts_library</code> migration to use the shared parts library and vendor sweep.</div></div>`;
      return;
    }

    // vendors from library items + standalone recipe lines
    const vendorSet = new Set();
    items.forEach(it => { if (it.vendor && it.vendor.trim()) vendorSet.add(it.vendor.trim()); });
    try {
      const { data: up } = await db.from('unit_parts').select('vendor').is('library_part_id', null);
      (up || []).forEach(r => { if (r.vendor && String(r.vendor).trim()) vendorSet.add(String(r.vendor).trim()); });
    } catch (e) { /* library_part_id column missing pre-2b — fine, skip */ }
    const vendors = [...vendorSet].sort((a, b) => a.localeCompare(b));

    const libCard = (it) => {
      const isBulk = it.cost_mode === 'bulk';
      return `
      <div class="cp-lib-card" data-lid="${esc(it.id)}">
        <div class="cp-lib-top">
          <input class="cp-lib-name" type="text" data-lf="name" value="${esc(it.name || '')}" placeholder="item name (e.g. ATF)">
          <input class="cp-lib-pn" type="text" data-lf="part_no" value="${esc(it.part_no || '')}" placeholder="part #">
          <input class="cp-lib-vendor" type="text" data-lf="vendor" value="${esc(it.vendor || '')}" placeholder="vendor">
          <select data-lf="cost_mode">
            <option value="flat"${isBulk ? '' : ' selected'}>Flat $/unit</option>
            <option value="bulk"${isBulk ? ' selected' : ''}>Bulk ÷ size</option>
          </select>
        </div>
        <div class="cp-lib-cost" data-mode-flat style="${isBulk ? 'display:none' : ''}">
          Cost <input type="number" data-lf="unit_cost" min="0" step="0.01" value="${it.unit_cost != null ? esc(String(it.unit_cost)) : ''}" placeholder="0.00"> /unit
        </div>
        <div class="cp-lib-cost" data-mode-bulk style="${isBulk ? '' : 'display:none'}">
          Bulk price <input type="number" data-lf="bulk_price" min="0" step="0.01" value="${it.bulk_price != null ? esc(String(it.bulk_price)) : ''}" placeholder="0.00">
          ÷ <input type="number" data-lf="bulk_qty" min="0" step="0.01" value="${it.bulk_qty != null ? esc(String(it.bulk_qty)) : ''}" placeholder="size">
          <input class="cp-lib-bulkunit" type="text" data-lf="bulk_unit" value="${esc(it.bulk_unit || '')}" placeholder="qt">
          = <span class="cp-lib-computed" data-computed>${fmtMoney(libUnitCost(it))}</span>/unit
        </div>
        <div class="cp-lib-actions">
          <button type="button" class="stgfeat-btn" data-lact="save" style="padding:4px 12px;font-size:0.75rem">Save</button>
          <button type="button" class="stgfeat-btn sec" data-lact="del" style="padding:4px 12px;font-size:0.75rem">Delete</button>
        </div>
        <div class="cp-lib-err" data-lerr></div>
      </div>`;
    };

    const listHtml = items.length ? items.map(libCard).join('') : '<div class="cp-lib-empty">No library items yet — add the first one below.</div>';
    const sweepVendorOpts = vendors.length
      ? vendors.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')
      : '<option value="">(no vendors yet)</option>';

    pane.innerHTML =
      `<div class="cp-cat-section-title">Shared parts library</div>
       <div class="cp-cat-section-sub">Reusable interchangeable parts entered once and linked into many unit recipes. Cost is a flat $/unit, or a bulk price ÷ bulk size (e.g. an ATF drum $1,268 ÷ 200 qt = $6.34/qt). Editing a cost here updates every recipe that links this item.</div>
       <div class="cp-lib-list">${listHtml}</div>

       <div class="cp-lib-card" data-lid="" style="border-style:dashed">
         <div class="cp-lib-top">
           <input class="cp-lib-name" type="text" data-nlf="name" placeholder="item name (e.g. ATF)">
           <input class="cp-lib-pn" type="text" data-nlf="part_no" placeholder="part #">
           <input class="cp-lib-vendor" type="text" data-nlf="vendor" placeholder="vendor">
           <select data-nlf="cost_mode">
             <option value="flat" selected>Flat $/unit</option>
             <option value="bulk">Bulk ÷ size</option>
           </select>
         </div>
         <div class="cp-lib-cost" data-mode-flat>
           Cost <input type="number" data-nlf="unit_cost" min="0" step="0.01" placeholder="0.00"> /unit
         </div>
         <div class="cp-lib-cost" data-mode-bulk style="display:none">
           Bulk price <input type="number" data-nlf="bulk_price" min="0" step="0.01" placeholder="0.00">
           ÷ <input type="number" data-nlf="bulk_qty" min="0" step="0.01" placeholder="size">
           <input class="cp-lib-bulkunit" type="text" data-nlf="bulk_unit" placeholder="qt">
           = <span class="cp-lib-computed" data-computed>$0.00</span>/unit
         </div>
         <div class="cp-lib-actions">
           <button type="button" class="stgfeat-btn" data-nladd style="padding:4px 12px;font-size:0.75rem">Add item</button>
         </div>
         <div class="cp-lib-err" data-nlerr></div>
       </div>

       <div class="cp-cat-section-title" style="margin-top:22px">Vendor bulk-cost sweep</div>
       <div class="cp-cat-section-sub">The inflation fix. Raise every part tagged to a vendor by a percent — standalone recipe lines and library items both (a bulk item's drum price is raised so its per-unit cost recomputes). Every affected unit's Cost / Profit / Margin updates when you reopen the Units tab.</div>
       <div class="cp-sweep">
         <div class="cp-sweep-row">
           <select id="cpSweepVendor">${sweepVendorOpts}</select>
           <span>change</span>
           <input type="number" id="cpSweepPct" class="cp-sweep-pct" step="0.1" placeholder="+5">
           <span>%</span>
           <button type="button" class="stgfeat-btn" id="cpSweepApply" style="padding:6px 14px">Apply</button>
           <button type="button" class="stgfeat-btn sec" id="cpSweepUndo" style="padding:6px 14px;${lastSweep ? '' : 'display:none'}">Undo last (${lastSweep ? esc(lastSweep.label) : ''})</button>
         </div>
         <div class="cp-sweep-summary" id="cpSweepSummary"></div>
         <div class="cp-sweep-err" id="cpSweepErr"></div>
       </div>`;

    wireLibCards(pane);
    wireSweep(pane);
  }

  // computed-cost live update + mode toggle for a library card's field group
  function wireLibComputed(scope, prefix) {
    const q = (n) => scope.querySelector(`[data-${prefix}="${n}"]`);
    const modeSel = q('cost_mode');
    const flatGrp = scope.querySelector('[data-mode-flat]');
    const bulkGrp = scope.querySelector('[data-mode-bulk]');
    const computed = scope.querySelector('[data-computed]');
    const recompute = () => {
      if (!computed) return;
      const mode = modeSel ? modeSel.value : 'flat';
      let per = 0;
      if (mode === 'bulk') { const bp = num(q('bulk_price') && q('bulk_price').value); const bq = num(q('bulk_qty') && q('bulk_qty').value); per = (bq && bq > 0) ? (bp || 0) / bq : 0; }
      else { per = num(q('unit_cost') && q('unit_cost').value) || 0; }
      computed.textContent = fmtMoney(per);
    };
    if (modeSel) modeSel.addEventListener('change', () => {
      const bulk = modeSel.value === 'bulk';
      if (flatGrp) flatGrp.style.display = bulk ? 'none' : '';
      if (bulkGrp) bulkGrp.style.display = bulk ? '' : 'none';
      recompute();
    });
    ['bulk_price', 'bulk_qty', 'unit_cost'].forEach(f => { const el = q(f); if (el) el.addEventListener('input', recompute); });
  }

  function wireLibCards(pane) {
    // add-new card
    const addCard = pane.querySelector('[data-lid=""]');
    wireLibComputed(addCard, 'nlf');
    addCard.querySelector('[data-nladd]').addEventListener('click', async () => {
      const err = addCard.querySelector('[data-nlerr]'); err.textContent = '';
      const g = (n) => (addCard.querySelector(`[data-nlf="${n}"]`) || {}).value;
      const name = (g('name') || '').trim();
      if (!name) { err.textContent = 'Enter an item name.'; return; }
      const mode = g('cost_mode') || 'flat';
      const rec = { name, part_no: (g('part_no') || '').trim() || null, vendor: (g('vendor') || '').trim() || null, cost_mode: mode };
      if (mode === 'bulk') { rec.bulk_price = num(g('bulk_price')) || 0; rec.bulk_qty = num(g('bulk_qty')) || 0; rec.bulk_unit = (g('bulk_unit') || '').trim() || null; }
      else { rec.unit_cost = num(g('unit_cost')) || 0; }
      const { error } = await cfg.db.from('parts_library').insert(rec);
      if (error) { err.textContent = 'Add failed: ' + error.message; return; }
      renderPartsCatalog(pane);
    });

    // existing cards
    pane.querySelectorAll('.cp-lib-card[data-lid]:not([data-lid=""])').forEach(card => {
      wireLibComputed(card, 'lf');
      const err = card.querySelector('[data-lerr]');
      card.querySelector('[data-lact="save"]').addEventListener('click', async () => {
        err.textContent = '';
        const g = (n) => (card.querySelector(`[data-lf="${n}"]`) || {}).value;
        const name = (g('name') || '').trim();
        if (!name) { err.textContent = 'Item name cannot be empty.'; return; }
        const mode = g('cost_mode') || 'flat';
        const update = { name, part_no: (g('part_no') || '').trim() || null, vendor: (g('vendor') || '').trim() || null, cost_mode: mode };
        if (mode === 'bulk') { update.bulk_price = num(g('bulk_price')) || 0; update.bulk_qty = num(g('bulk_qty')) || 0; update.bulk_unit = (g('bulk_unit') || '').trim() || null; }
        else { update.unit_cost = num(g('unit_cost')) || 0; }
        const { error } = await cfg.db.from('parts_library').update(update).eq('id', card.dataset.lid);
        if (error) { err.textContent = 'Save failed: ' + error.message; return; }
        const btn = card.querySelector('[data-lact="save"]');
        if (btn) { btn.textContent = 'Saved ✓'; setTimeout(() => { if (btn.isConnected) btn.textContent = 'Save'; }, 900); }
        renderPartsCatalog(pane);   // refresh so linked-line costs everywhere reflect it
      });
      card.querySelector('[data-lact="del"]').addEventListener('click', async () => {
        err.textContent = '';
        // block deleting an item still used by a recipe line (graceful).
        let used = 0;
        try {
          const { count } = await cfg.db.from('unit_parts').select('id', { count: 'exact', head: true }).eq('library_part_id', card.dataset.lid);
          used = count || 0;
        } catch (e) { /* pre-2b column missing → treat as unused */ }
        if (used > 0) { err.textContent = `Used in ${used} recipe line${used === 1 ? '' : 's'} — remove those first.`; return; }
        const nm = (card.querySelector('[data-lf="name"]') || {}).value || 'this item';
        if (!confirm('Delete library item "' + nm + '"?')) return;
        const { error } = await cfg.db.from('parts_library').delete().eq('id', card.dataset.lid);
        if (error) { err.textContent = 'Delete failed: ' + error.message; return; }
        renderPartsCatalog(pane);
      });
    });
  }

  function wireSweep(pane) {
    pane.querySelector('#cpSweepApply').addEventListener('click', () => applyVendorSweep(pane));
    const undo = pane.querySelector('#cpSweepUndo');
    if (undo) undo.addEventListener('click', () => undoLastSweep(pane));
  }

  async function applyVendorSweep(pane) {
    const db = cfg.db;
    const err = pane.querySelector('#cpSweepErr'); err.textContent = '';
    const vendor = pane.querySelector('#cpSweepVendor').value;
    const pct = num(pane.querySelector('#cpSweepPct').value);
    if (!vendor) { err.textContent = 'Pick a vendor.'; return; }
    if (pct == null) { err.textContent = 'Enter a percent (e.g. 5 for +5%).'; return; }
    const factor = 1 + pct / 100;
    if (factor < 0) { err.textContent = 'That would make costs negative.'; return; }
    const changes = [];
    const unitIds = new Set();
    try {
      // library items of this vendor: bulk → raise drum price; flat → raise unit_cost
      const { data: libItems, error: e1 } = await db.from('parts_library').select('*').eq('vendor', vendor);
      if (e1) throw e1;
      for (const it of (libItems || [])) {
        if (it.cost_mode === 'bulk') {
          const old = Number(it.bulk_price) || 0;
          changes.push({ table: 'parts_library', id: it.id, field: 'bulk_price', old });
          await db.from('parts_library').update({ bulk_price: round2(old * factor) }).eq('id', it.id);
        } else {
          const old = Number(it.unit_cost) || 0;
          changes.push({ table: 'parts_library', id: it.id, field: 'unit_cost', old });
          await db.from('parts_library').update({ unit_cost: round2(old * factor) }).eq('id', it.id);
        }
      }
      const libIds = (libItems || []).map(it => String(it.id));
      // standalone recipe lines of this vendor
      const { data: upRows, error: e2 } = await db.from('unit_parts').select('id,unit_cost,package_unit_id').eq('vendor', vendor).is('library_part_id', null);
      if (e2) throw e2;
      for (const r of (upRows || [])) {
        const old = Number(r.unit_cost) || 0;
        changes.push({ table: 'unit_parts', id: r.id, field: 'unit_cost', old });
        await db.from('unit_parts').update({ unit_cost: round2(old * factor) }).eq('id', r.id);
        if (r.package_unit_id) unitIds.add(String(r.package_unit_id));
      }
      // units affected via linked lines referencing swept library items
      if (libIds.length) {
        const { data: linkedRows } = await db.from('unit_parts').select('package_unit_id').in('library_part_id', libIds);
        (linkedRows || []).forEach(r => { if (r.package_unit_id) unitIds.add(String(r.package_unit_id)); });
      }
    } catch (e) {
      err.textContent = 'Sweep failed: ' + (e.message || e);
      return;
    }
    lastSweep = { changes, label: `${vendor} ${pct >= 0 ? '+' : ''}${pct}%` };
    const n = changes.length;
    const m = unitIds.size;
    const msg = n === 0
      ? `No parts tagged to <strong>${esc(vendor)}</strong> — nothing changed.`
      : `<strong>${esc(vendor)} ${pct >= 0 ? '+' : ''}${pct}%</strong> → ${n} part${n === 1 ? '' : 's'} updated across ${m} unit${m === 1 ? '' : 's'}. Reopen the Units tab to see new margins.`;
    // renderPartsCatalog rebuilds the pane (a fresh #cpSweepSummary) — await it,
    // THEN inject the message so the rebuild doesn't wipe it.
    await renderPartsCatalog(pane);
    const s2 = pane.querySelector('#cpSweepSummary');
    if (s2) s2.innerHTML = msg;
  }

  async function undoLastSweep(pane) {
    if (!lastSweep) return;
    const db = cfg.db;
    const err = pane.querySelector('#cpSweepErr'); if (err) err.textContent = '';
    try {
      for (const c of lastSweep.changes) {
        await db.from(c.table).update({ [c.field]: c.old }).eq('id', c.id);
      }
    } catch (e) { if (err) err.textContent = 'Undo failed: ' + (e.message || e); return; }
    const label = lastSweep.label;
    lastSweep = null;
    await renderPartsCatalog(pane);
    const s = pane.querySelector('#cpSweepSummary');
    if (s) s.innerHTML = `Reverted <strong>${esc(label)}</strong>.`;
  }

  // ── People & rates tab ───────────────────────────────────────
  async function renderPeopleRates(pane) {
    pane.innerHTML = '<div class="bsheet-stub">Loading…</div>';
    try { if (window.BoardSettings && BoardSettings.reloadShopSettings) await BoardSettings.reloadShopSettings(); } catch (e) {}
    const s = (window.BoardSettings && BoardSettings.getShopSettings) ? BoardSettings.getShopSettings() : {};
    if (s._exists === false) {
      pane.innerHTML = '<div class="bsheet-stub">Run the <code>shop_settings</code> migration to set standard rates.</div>';
      return;
    }
    const rr = s.std_rr_rate != null ? s.std_rr_rate : 0;
    const rb = s.rebuilder_cost != null ? s.rebuilder_cost : 0;
    const adv = s.std_advisor_pct != null ? s.std_advisor_pct : 2.5;
    pane.innerHTML =
      `<div class="cp-rates">
        <p class="cp-rate-note">Standard-cost placeholders used by the Build Sheet's profit estimate. Tune them like assumptions — they are <strong>separate</strong> from the live Advisor Commission pay settings.</p>
        <div class="cp-rate-field">
          <div><div class="cp-rate-lbl">Standard R&amp;R rate</div><div class="cp-rate-sub">$ per flagged hour</div></div>
          <input type="number" id="cpRrRate" min="0" step="0.01" value="${esc(String(rr))}">
        </div>
        <div class="cp-rate-field">
          <div><div class="cp-rate-lbl">Rebuilder cost</div><div class="cp-rate-sub">$ per unit built</div></div>
          <input type="number" id="cpRebuilder" min="0" step="0.01" value="${esc(String(rb))}">
        </div>
        <div class="cp-rate-field">
          <div><div class="cp-rate-lbl">Standard advisor %</div><div class="cp-rate-sub">% of sale</div></div>
          <input type="number" id="cpAdvPct" min="0" step="0.1" value="${esc(String(adv))}">
        </div>
        <button type="button" class="stgfeat-btn" id="cpRatesSave" style="margin-top:16px">Save rates</button>
        <div class="cp-rate-err" id="cpRatesErr"></div>
      </div>`;

    const errEl = pane.querySelector('#cpRatesErr');
    pane.querySelector('#cpRatesSave').addEventListener('click', async () => {
      errEl.textContent = '';
      const rrRate = num(pane.querySelector('#cpRrRate').value);
      const reb = num(pane.querySelector('#cpRebuilder').value);
      const advPct = num(pane.querySelector('#cpAdvPct').value);
      for (const [v, label] of [[rrRate, 'R&R rate'], [reb, 'Rebuilder cost'], [advPct, 'advisor %']]) {
        if (v != null && v < 0) { errEl.textContent = `${label} cannot be negative.`; return; }
      }
      const id = s._id || '00000000-0000-0000-0000-000000000001';
      const update = { std_rr_rate: rrRate == null ? 0 : rrRate, rebuilder_cost: reb == null ? 0 : reb, std_advisor_pct: advPct == null ? 0 : advPct };
      const { error } = await cfg.db.from('shop_settings').update(update).eq('id', id);
      if (error) {
        const missing = error.code === 'PGRST204' || /column/i.test(error.message || '');
        errEl.textContent = missing ? 'Run the Step 2a migration first (rate columns missing).' : 'Save failed: ' + error.message;
        return;
      }
      try { if (window.BoardSettings && BoardSettings.reloadShopSettings) await BoardSettings.reloadShopSettings(); } catch (e) {}
      const btn = pane.querySelector('#cpRatesSave');
      if (btn) { btn.textContent = 'Saved ✓'; setTimeout(() => { if (btn.isConnected) btn.textContent = 'Save rates'; }, 1000); }
    });
  }

  // ── Tab shell ────────────────────────────────────────────────
  function renderTab(root) {
    const pane = root.querySelector('.bsheet-pane');
    if (!pane) return;
    openPanels.clear();      // panels belong to a specific render; drop stale refs
    root.querySelectorAll('.bsheet-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));

    if (activeTab === 'units') {
      if (window.BoardSettings && typeof BoardSettings.renderRebuildUnits === 'function') {
        BoardSettings.renderRebuildUnits(pane, { db: cfg.db, costLayer: makeCostLayer(cfg.db) });
      } else {
        pane.innerHTML = '<div class="bsheet-stub">Settings module not loaded — cannot show units.</div>';
      }
      return;
    }
    if (activeTab === 'people') { renderPeopleRates(pane); return; }
    renderPartsCatalog(pane);   // parts catalog & vendor pricing
  }

  function build(root) {
    injectStyles();
    root.innerHTML =
      `<div class="bsheet-tabs">` +
        TABS.map(t => `<button type="button" class="bsheet-tab" data-tab="${t.key}">${esc(t.label)}</button>`).join('') +
      `</div><div class="bsheet-pane"></div>`;
    root.querySelectorAll('.bsheet-tab').forEach(b =>
      b.addEventListener('click', () => { activeTab = b.dataset.tab; renderTab(root); }));
    root.dataset.bsheetBuilt = '1';
  }

  // Mount (or refresh) the Build Sheet into `container`. Builds the shell once;
  // always re-renders the active tab so numbers are fresh on each open.
  function mount(container, config) {
    if (!container) return;
    cfg = config || {};
    if (container.dataset.bsheetBuilt !== '1') build(container);
    renderTab(container);
  }

  return { mount };
})();
