// ============================================================
// Build Sheet — the "Cost & Profit" workbench (Step 1 frame).
//
// A single shared surface mounted on the Owner and Bookkeeping boards under
// the Cost & Profit sidebar group. It is an inner sub-tab bar with three tabs:
//
//   • Units                          — ACTIVE. The existing "Rebuild Units &
//                                       Prices" editor, moved here verbatim. It
//                                       is BoardSettings.renderRebuildUnits() —
//                                       the ONE shared copy also used by the
//                                       Settings pane when the feature is OFF.
//   • Parts catalog & vendor pricing — stub ("Coming in Step 2").
//   • People & rates                 — stub ("Coming in Step 2").
//
// Step 1 is FRAME + RELOCATION ONLY: no cost math, no new tables, no parts
// recipes / vendor costs / profit. Those are Steps 2 and 3.
//
// Self-contained: injects its own <style> once and relies on BoardSettings
// (loaded on every board) for the Units editor + its shared button styles.
//
// Usage (per board):
//   <div class="view" id="view-buildsheet"><div id="buildsheet-root"></div></div>
//   BuildSheet.mount(document.getElementById('buildsheet-root'), { db });
// mount() is idempotent — the shell is built once; each call re-renders the
// active tab so the Units list reflects the latest data on every open.
// ============================================================

window.BuildSheet = (function () {
  let stylesInjected = false;
  let activeTab = 'units';
  let cfg = null;               // { db }

  const TABS = [
    { key: 'units', label: 'Units' },
    { key: 'parts', label: 'Parts catalog & vendor pricing' },
    { key: 'people', label: 'People & rates' },
  ];

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
    `;
    document.head.appendChild(style);
  }

  function renderTab(root) {
    const pane = root.querySelector('.bsheet-pane');
    if (!pane) return;
    root.querySelectorAll('.bsheet-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === activeTab));

    if (activeTab === 'units') {
      // The shared Rebuild Units editor (ONE copy — same as Settings when the
      // Cost & Profit feature is OFF). BoardSettings is loaded on every board.
      if (window.BoardSettings && typeof BoardSettings.renderRebuildUnits === 'function') {
        BoardSettings.renderRebuildUnits(pane, { db: cfg.db });
      } else {
        pane.innerHTML = '<div class="bsheet-stub">Settings module not loaded — cannot show units.</div>';
      }
      return;
    }
    // Steps 2/3 land here. Frame only for now.
    const stubLabel = activeTab === 'parts'
      ? 'Parts catalog & vendor pricing'
      : 'People & rates';
    pane.innerHTML =
      `<div class="bsheet-stub"><div class="bsheet-stub-badge">Coming in Step 2</div>` +
      `<div>${stubLabel} lands here next.</div></div>`;
  }

  function build(root) {
    injectStyles();
    root.innerHTML =
      `<div class="bsheet-tabs">` +
        TABS.map(t => `<button type="button" class="bsheet-tab" data-tab="${t.key}">${t.label}</button>`).join('') +
      `</div><div class="bsheet-pane"></div>`;
    root.querySelectorAll('.bsheet-tab').forEach(b =>
      b.addEventListener('click', () => { activeTab = b.dataset.tab; renderTab(root); }));
    root.dataset.bsheetBuilt = '1';
  }

  // Mount (or refresh) the Build Sheet into `container`. Builds the shell once;
  // always re-renders the active tab so the Units list is fresh on each open.
  function mount(container, config) {
    if (!container) return;
    cfg = config || {};
    if (container.dataset.bsheetBuilt !== '1') build(container);
    renderTab(container);
  }

  return { mount };
})();
