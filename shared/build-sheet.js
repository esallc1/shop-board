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
//   • Parts catalog & vendor pricing — stub ("Coming in Step 2b": shared parts
//                      library + vendor bulk-cost sweep).
//   • People & rates — three shop-level standard-cost rate inputs (Standard R&R
//                      rate, Rebuilder cost, Standard advisor %), saved to
//                      shop_settings. Placeholders the owner tunes; INDEPENDENT
//                      of the live Advisor Commission engine.
//
// Step 2a = enter parts + see live profit. NOT here: shared parts library /
// vendor sweep (2b), the Cockpit (3), a per-person roster or actual-vs-standard
// (3). No feature switch — ships via preview → prod.
//
// STANDARD COST (per unit):
//   Σ(part cost × qty) + (R&R Hrs × Standard R&R rate) + Rebuilder cost
//     + (Set Price × Standard advisor %)
//   Profit = Set Price − Standard cost ; Margin = Profit ÷ Set Price
// A unit with NO recipe (zero parts) shows an honest "No cost set" — never $0.
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
    `;
    document.head.appendChild(style);
  }

  // ── Cost math ────────────────────────────────────────────────
  function partsFor(ctx, unitId) { return (ctx && ctx.partsByUnit.get(String(unitId))) || []; }
  function computeCost(live, parts, rates) {
    const partsCost = parts.reduce((s, p) => s + (Number(p.unit_cost) || 0) * (Number(p.qty) || 0), 0);
    const rrHours = Number(live.default_rr_hours) || 0;
    const rr = rrHours * (Number(rates.std_rr_rate) || 0);
    const rebuild = Number(rates.rebuilder_cost) || 0;
    const advisorPct = Number(rates.std_advisor_pct) || 0;      // percentage number, e.g. 2.5
    const price = Number(live.set_price) || 0;
    const advisor = price * (advisorPct / 100);
    return { partsCost, rrHours, rr, rebuild, advisorPct, advisor, price, total: partsCost + rr + rebuild + advisor };
  }

  // Warm rates (from shop_settings via BoardSettings) + ALL recipe parts once.
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
    return { rates, partsByUnit, tableMissing, db };
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
    const c = computeCost(live, parts, ctx.rates);
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
    const c = computeCost(live, parts, ctx.rates);
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
    const partRow = (p) => `
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
    const bodyRows = parts.length
      ? parts.map(partRow).join('')
      : '<tr><td colspan="6" style="color:var(--muted);padding:6px">No parts yet — add the first line below.</td></tr>';

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
        <div class="cp-part-err" data-perr></div>
        <div data-resultbox></div>
      </div>`;

    const resultBox = cell.querySelector('[data-resultbox]');
    resultBox.innerHTML = resultBoxHtml(handle, ctx);
    openPanels.set(unitId, resultBox);

    const errEl = cell.querySelector('[data-perr]');
    const fail = (m) => { if (errEl) errEl.textContent = m || ''; };
    const isMissingCol = (e) => e && (e.code === '42P01' || e.code === 'PGRST204' || /relation|column|does not exist/i.test(e.message || ''));

    // after any mutation: reload this unit's parts, re-render the panel + summary.
    const refresh = async () => {
      await refreshUnitParts(ctx, unitId);
      renderRecipeInner(cell, handle, ctx);                 // rebuilds the panel (keeps it open)
      try { handle.setSummary(summaryHtml(handle, ctx)); } catch (e) {}
    };

    cell.querySelector('[data-nadd]').addEventListener('click', async () => {
      fail('');
      const g = (sel) => cell.querySelector(`[data-nf="${sel}"]`).value;
      const name = (g('name') || '').trim();
      const part_no = (g('part_no') || '').trim() || null;
      const vendor = (g('vendor') || '').trim() || null;
      const unit_cost = num(g('unit_cost'));
      const qtyRaw = num(g('qty'));
      if (!name) { fail('Enter a part name.'); return; }
      if (unit_cost != null && unit_cost < 0) { fail('Cost cannot be negative.'); return; }
      const qty = qtyRaw == null ? 1 : qtyRaw;                // default qty 1
      if (qty < 0) { fail('Qty cannot be negative.'); return; }
      const { error } = await ctx.db.from('unit_parts').insert({
        package_unit_id: unitId, name, part_no, vendor, unit_cost: unit_cost == null ? 0 : unit_cost, qty,
      });
      if (error) { fail(isMissingCol(error) ? 'Run the unit_parts migration (Step 2a) first.' : 'Add failed: ' + error.message); return; }
      await refresh();
    });

    cell.querySelectorAll('tr[data-pid]').forEach(tr => {
      tr.querySelector('[data-pact="save"]').addEventListener('click', async () => {
        fail('');
        const g = (sel) => tr.querySelector(`[data-pf="${sel}"]`).value;
        const name = (g('name') || '').trim();
        if (!name) { fail('Part name cannot be empty.'); return; }
        const unit_cost = num(g('unit_cost'));
        const qty = num(g('qty'));
        const { error } = await ctx.db.from('unit_parts').update({
          name, part_no: (g('part_no') || '').trim() || null, vendor: (g('vendor') || '').trim() || null,
          unit_cost: unit_cost == null ? 0 : unit_cost, qty: qty == null ? 1 : qty,
        }).eq('id', tr.dataset.pid);
        if (error) { fail('Save failed: ' + error.message); return; }
        const btn = tr.querySelector('[data-pact="save"]');
        if (btn) { const o = btn.textContent; btn.textContent = 'Saved'; setTimeout(() => { if (btn.isConnected) btn.textContent = o; }, 900); }
        await refresh();
      });
      tr.querySelector('[data-pact="del"]').addEventListener('click', async () => {
        fail('');
        const nm = (tr.querySelector('[data-pf="name"]') || {}).value || 'this part';
        if (!confirm('Delete part "' + nm + '"?')) return;
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
    // parts catalog & vendor pricing → Step 2b
    pane.innerHTML =
      `<div class="bsheet-stub"><div class="bsheet-stub-badge">Coming in Step 2b</div>` +
      `<div>Parts catalog &amp; vendor pricing (a shared parts library + vendor bulk-cost sweep) lands here next.</div></div>`;
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
