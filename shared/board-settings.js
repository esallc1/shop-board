// ============================================================
// Shared "Settings" panel — consolidates per-employee preferences
// (Display Name, Background Photo, and room for more later) behind
// a single gear-icon trigger, mounted the same way on every board
// (Advisor, Bookkeeping, GM, Owner).
//
// Supersedes the standalone "Background" button (shared/board-
// background.js) — that file's upload/reset logic against the
// board-backgrounds storage bucket and employees.background_photo_url
// column is preserved here unchanged, just relocated into a section
// of this panel instead of its own button. The previous button was a
// full-width text label ("BACKGROUND") competing for space with Log
// Out + Refresh in a 232px sidebar column and wrapped awkwardly; this
// trigger is icon-only (matching the existing Refresh button's
// footprint) specifically to avoid that.
//
// Fully self-contained — injects its own <style> and modal markup at
// runtime, so it works identically whether or not the host page
// already includes shared/board-shell.css (owner-board.html doesn't).
// Each board only needs:
//
//   <script src="shared/board-settings.js"></script>
//   <script>
//     BoardSettings.init({
//       db,
//       targetSelector: '.main-area',       // '.content' on owner-board
//       mountSelector: '.sidebar-btn-row',  // '.header-controls' on owner-board
//       onNameSaved: (name) => { CHAT_IDENTITY.name = name; },
//     });
//     // once the logged-in employee's id is known:
//     BoardSettings.refresh(employeeId);
//   </script>
// ============================================================

window.BoardSettings = (function () {
  const BUCKET = 'board-backgrounds';
  const OVERLAY = 'rgba(245,246,250,0.86)'; // matches --bg (#f5f6fa) across every board's :root

  let db = null;
  let targetEl = null;
  let onNameSaved = null;
  let currentEmployeeId = null;
  let currentUrl = null;
  let currentName = null;
  let pendingFile = null;
  let stylesInjected = false;
  let modalEl = null;

  // ── Shop / RO settings (shop_settings table) ──────────────────
  // Single fixed-id row. Permission split is UI-level: which board
  // renders an EDITABLE control (money vs operational) is decided by
  // the flags passed to init() — same pattern as the Bookkeeping-only
  // delete button. Money (tax %, labor rate) edits on Owner/GM only;
  // the operational toggle (show_tech_on_ro) also edits on Advisor.
  const SHOP_SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
  const SHOP_DEFAULTS = {
    tax_rate: 0.07, default_labor_rate: null, show_tech_on_ro: false,
    card_fee_pct: 0.03, shop_supplies_default: 0, hazmat_default: 0,
  };
  let shopSettingsRow = null;   // raw row, or null if table/row missing
  let canEditShopMoney = false;
  let canEditShopOps = false;
  let onShopSettingsChanged = null;

  // Resolved settings the rest of the app reads. Always safe — falls
  // back to defaults (tax 0.07) when the row/table doesn't exist yet
  // (pre-migration), so the RO Board never breaks between deploy and
  // Cris applying the migration.
  function getShopSettings() {
    if (!shopSettingsRow) return { ...SHOP_DEFAULTS, _exists: false, _id: null };
    const n = (v, d) => (v != null && Number.isFinite(Number(v))) ? Number(v) : d;
    return {
      tax_rate: n(shopSettingsRow.tax_rate, SHOP_DEFAULTS.tax_rate),
      default_labor_rate: shopSettingsRow.default_labor_rate != null ? Number(shopSettingsRow.default_labor_rate) : null,
      show_tech_on_ro: !!shopSettingsRow.show_tech_on_ro,
      card_fee_pct: n(shopSettingsRow.card_fee_pct, SHOP_DEFAULTS.card_fee_pct),
      shop_supplies_default: n(shopSettingsRow.shop_supplies_default, SHOP_DEFAULTS.shop_supplies_default),
      hazmat_default: n(shopSettingsRow.hazmat_default, SHOP_DEFAULTS.hazmat_default),
      _exists: true,
      _id: shopSettingsRow.id,
    };
  }

  async function loadShopSettings() {
    try {
      const { data, error } = await db.from('shop_settings').select('*').limit(1).maybeSingle();
      if (error) throw error;          // e.g. 42P01 if table not created yet
      shopSettingsRow = data || null;
    } catch (err) {
      // table missing (pre-migration) or transient — fall back silently
      shopSettingsRow = null;
      console.warn('[BoardSettings] shop_settings not loaded (using defaults):', err.message || err);
    }
    if (typeof onShopSettingsChanged === 'function') onShopSettingsChanged(getShopSettings());
  }

  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .stgfeat-target.stgfeat-has-image {
        background-image: linear-gradient(${OVERLAY}, ${OVERLAY}), var(--stgfeat-url);
        background-size: cover;
        background-position: center;
        background-attachment: fixed;
      }

      /* Room for a 3rd sidebar-btn-row item (this trigger) without the
         awkward in-button text wrap the old text-label Background
         button had — buttons keep single-line text, and the row wraps
         to a second line first if it ever truly runs out of room. */
      .sidebar-btn-row { flex-wrap: wrap; }
      .logout-btn, .refresh-btn { white-space: nowrap; flex-shrink: 0; }

      .stgfeat-trigger-btn {
        display: flex; align-items: center; justify-content: center;
        color: #8c93a8;
        background: transparent;
        border: 0.5px solid #e2e5ee;
        border-radius: 6px;
        padding: 6px 12px;
        font-family: inherit; cursor: pointer;
        transition: background 0.15s;
        flex-shrink: 0;
      }
      .stgfeat-trigger-btn:hover { background: #f0f1f5; }
      .stgfeat-trigger-icon { width: 14px; height: 14px; flex-shrink: 0; }

      .stgfeat-overlay {
        display: none; position: fixed; inset: 0; background: rgba(20,22,40,0.45);
        z-index: 6000; align-items: center; justify-content: center;
      }
      .stgfeat-overlay.open { display: flex; }
      .stgfeat-box {
        background: #fff; border-radius: 12px; padding: 24px; width: 380px; max-width: 90vw;
        max-height: 85vh; overflow-y: auto;
        box-shadow: 0 20px 50px rgba(0,0,0,0.25); font-family: 'Segoe UI', system-ui, sans-serif;
        position: relative;
      }
      .stgfeat-box h3 { font-size: 1rem; color: #1a1f36; margin: 0 0 18px; }
      .stgfeat-close {
        position: absolute; top: 18px; right: 20px; background: none; border: none;
        font-size: 1.3rem; color: #8c93a8; cursor: pointer; line-height: 1; padding: 0;
      }
      .stgfeat-close:hover { color: #1a1f36; }

      .stgfeat-section { padding: 16px 0; border-bottom: 1px solid #e2e5ee; }
      .stgfeat-section:first-of-type { padding-top: 0; }
      .stgfeat-section:last-of-type { border-bottom: none; padding-bottom: 0; }
      .stgfeat-section-label {
        font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.8px;
        color: #8c93a8; font-weight: 700; margin-bottom: 10px;
      }
      .stgfeat-placeholder { color: #8c93a8; font-size: 0.8rem; }

      .stgfeat-name-row { display: flex; gap: 8px; }
      .stgfeat-name-row input {
        flex: 1; padding: 8px 10px; border: 1px solid #e2e5ee; border-radius: 6px;
        font-size: 0.85rem; font-family: inherit; color: #1a1f36;
      }
      .stgfeat-name-row input:focus { outline: none; border-color: #5b5ef4; }

      .stgfeat-preview {
        width: 100%; height: 110px; border-radius: 8px; background: #f0f1f5;
        background-size: cover; background-position: center;
        display: flex; align-items: center; justify-content: center;
        color: #8c93a8; font-size: 0.78rem; margin-bottom: 12px; overflow: hidden;
      }
      .stgfeat-choose-btn {
        display: block; width: 100%; text-align: center; padding: 9px 0;
        border: 1px dashed #e2e5ee; border-radius: 6px; background: #f0f1f5;
        color: #1a1f36; font-size: 0.82rem; font-weight: 600; cursor: pointer;
        margin-bottom: 12px; font-family: inherit;
      }
      .stgfeat-choose-btn:hover { background: #e2e5ee; }
      .stgfeat-bg-btn-row { display: flex; gap: 8px; }

      .stgfeat-error { color: #dc2626; font-size: 0.78rem; min-height: 16px; margin-top: 6px; }
      .stgfeat-btn {
        padding: 8px 14px; border-radius: 6px;
        border: none; background: #5b5ef4; color: #fff; font-weight: 600;
        font-size: 0.82rem; cursor: pointer; font-family: inherit;
        transition: opacity 0.15s;
      }
      .stgfeat-btn:hover { opacity: 0.9; }
      .stgfeat-btn:disabled { opacity: 0.5; cursor: default; }
      .stgfeat-btn.sec { background: #f0f1f5; color: #1a1f36; border: 1px solid #e2e5ee; }
      .stgfeat-btn.danger { background: #fff; color: #dc2626; border: 1px solid #fca5a5; }
      .stgfeat-btn.block { display: block; width: 100%; }

      .stgfeat-field {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; margin-bottom: 10px;
      }
      .stgfeat-field label { font-size: 0.82rem; color: #1a1f36; }
      .stgfeat-field input[type="number"] {
        width: 120px; padding: 7px 10px; border: 1px solid #e2e5ee; border-radius: 6px;
        font-size: 0.85rem; font-family: inherit; color: #1a1f36; text-align: right;
      }
      .stgfeat-field input[type="number"]:focus { outline: none; border-color: #5b5ef4; }
      .stgfeat-field-check input { width: 16px; height: 16px; cursor: pointer; }
      .stgfeat-static { font-size: 0.85rem; color: #1a1f36; font-weight: 600; }
      #stgfeatShopBody code {
        background: #f0f1f5; border-radius: 4px; padding: 1px 4px; font-size: 0.78rem;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'stgfeat-overlay';
    modalEl.innerHTML = `
      <div class="stgfeat-box">
        <button type="button" class="stgfeat-close" id="stgfeatCloseBtn">&times;</button>
        <h3>Settings</h3>

        <div class="stgfeat-section">
          <div class="stgfeat-section-label">Display Name</div>
          <div class="stgfeat-name-row">
            <input type="text" id="stgfeatNameInput" placeholder="Your name">
            <button type="button" class="stgfeat-btn" id="stgfeatNameSaveBtn">Save</button>
          </div>
          <div class="stgfeat-error" id="stgfeatNameError"></div>
        </div>

        <div class="stgfeat-section">
          <div class="stgfeat-section-label">Background Photo</div>
          <div class="stgfeat-preview" id="stgfeatPreview">No photo selected</div>
          <input type="file" accept="image/*" id="stgfeatFileInput" style="display:none">
          <button type="button" class="stgfeat-choose-btn" id="stgfeatChooseBtn">Choose Photo…</button>
          <div class="stgfeat-bg-btn-row">
            <button type="button" class="stgfeat-btn block" id="stgfeatBgSaveBtn" disabled>Save Background</button>
            <button type="button" class="stgfeat-btn danger block" id="stgfeatBgResetBtn">Reset</button>
          </div>
          <div class="stgfeat-error" id="stgfeatBgError"></div>
        </div>

        <div class="stgfeat-section">
          <div class="stgfeat-section-label">Shop / RO Settings</div>
          <div id="stgfeatShopBody"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    modalEl.querySelector('#stgfeatCloseBtn').addEventListener('click', closeModal);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });

    modalEl.querySelector('#stgfeatNameSaveBtn').addEventListener('click', saveName);

    const fileInput = modalEl.querySelector('#stgfeatFileInput');
    const preview = modalEl.querySelector('#stgfeatPreview');
    const bgSaveBtn = modalEl.querySelector('#stgfeatBgSaveBtn');

    modalEl.querySelector('#stgfeatChooseBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      pendingFile = file;
      const reader = new FileReader();
      reader.onload = () => {
        preview.style.backgroundImage = `url("${reader.result}")`;
        preview.textContent = '';
      };
      reader.readAsDataURL(file);
      bgSaveBtn.disabled = false;
    });

    bgSaveBtn.addEventListener('click', saveBackground);
    modalEl.querySelector('#stgfeatBgResetBtn').addEventListener('click', resetBackground);

    return modalEl;
  }

  function openModal() {
    if (!currentEmployeeId) {
      alert('Log in first — Settings are saved to your employee profile.');
      return;
    }
    ensureModal();
    pendingFile = null;

    modalEl.querySelector('#stgfeatNameInput').value = currentName || '';
    modalEl.querySelector('#stgfeatNameError').textContent = '';

    modalEl.querySelector('#stgfeatFileInput').value = '';
    modalEl.querySelector('#stgfeatBgError').textContent = '';
    modalEl.querySelector('#stgfeatBgSaveBtn').disabled = true;
    const preview = modalEl.querySelector('#stgfeatPreview');
    if (currentUrl) {
      preview.style.backgroundImage = `url("${currentUrl}")`;
      preview.textContent = '';
    } else {
      preview.style.backgroundImage = '';
      preview.textContent = 'No photo selected';
    }

    renderShopSection();
    loadShopSettings().then(renderShopSection);   // refresh in case another board changed it

    modalEl.classList.add('open');
  }

  function closeModal() {
    if (modalEl) modalEl.classList.remove('open');
    pendingFile = null;
  }

  // On a SUCCESSFUL save: show a brief "Saved ✓" state, then close the
  // panel and restore the button's label (so it's clean on reopen).
  // Failed saves never call this — they keep the panel open + show the
  // error, per the requested behavior.
  function flashSavedThenClose(saveBtn, defaultText) {
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saved ✓'; }
    setTimeout(() => {
      if (saveBtn && saveBtn.isConnected) { saveBtn.disabled = false; saveBtn.textContent = defaultText; }
      closeModal();
    }, 650);
  }

  async function saveName() {
    const errEl = modalEl.querySelector('#stgfeatNameError');
    const saveBtn = modalEl.querySelector('#stgfeatNameSaveBtn');
    const name = modalEl.querySelector('#stgfeatNameInput').value.trim();
    errEl.textContent = '';

    if (!name) {
      errEl.textContent = 'Name cannot be empty.';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    const { error } = await db.from('employees').update({ name }).eq('id', currentEmployeeId);

    if (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      console.error('[BoardSettings] name save failed', error);
      errEl.textContent = 'Save failed: ' + error.message;
      return;
    }

    currentName = name;
    const greetingSpan = document.querySelector('#greetingWrap span');
    if (greetingSpan) greetingSpan.textContent = `Hi, ${name}`;
    if (typeof onNameSaved === 'function') onNameSaved(name);
    flashSavedThenClose(saveBtn, 'Save');
  }

  function applyBackground(url) {
    currentUrl = url || null;
    if (!targetEl) return;
    targetEl.classList.add('stgfeat-target');
    if (currentUrl) {
      targetEl.style.setProperty('--stgfeat-url', `url("${currentUrl}")`);
      targetEl.classList.add('stgfeat-has-image');
    } else {
      targetEl.classList.remove('stgfeat-has-image');
      targetEl.style.removeProperty('--stgfeat-url');
    }
  }

  async function saveBackground() {
    if (!pendingFile || !currentEmployeeId) return;
    const errEl = modalEl.querySelector('#stgfeatBgError');
    const saveBtn = modalEl.querySelector('#stgfeatBgSaveBtn');
    errEl.textContent = '';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      const ext = (pendingFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${currentEmployeeId}/${Date.now()}.${ext}`;
      const { error: upErr } = await db.storage.from(BUCKET).upload(path, pendingFile, { upsert: true });
      if (upErr) throw upErr;

      const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
      const url = pub.publicUrl;

      const { error: updErr } = await db.from('employees').update({ background_photo_url: url }).eq('id', currentEmployeeId);
      if (updErr) throw updErr;

      applyBackground(url);
      pendingFile = null;
      flashSavedThenClose(saveBtn, 'Save Background');
    } catch (err) {
      console.error('[BoardSettings] background save failed', err);
      errEl.textContent = 'Save failed: ' + (err.message || 'unknown error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Background';
    }
  }

  async function resetBackground() {
    if (!currentEmployeeId) return;
    const errEl = modalEl.querySelector('#stgfeatBgError');
    const resetBtn = modalEl.querySelector('#stgfeatBgResetBtn');
    errEl.textContent = '';
    resetBtn.disabled = true;

    const { error } = await db.from('employees').update({ background_photo_url: null }).eq('id', currentEmployeeId);
    resetBtn.disabled = false;

    if (error) {
      console.error('[BoardSettings] reset failed', error);
      errEl.textContent = 'Reset failed: ' + error.message;
      return;
    }

    applyBackground(null);
    const preview = modalEl.querySelector('#stgfeatPreview');
    preview.style.backgroundImage = '';
    preview.textContent = 'No photo selected';
  }

  // ── Shop / RO settings: render + save ─────────────────────────
  function renderShopSection() {
    if (!modalEl) return;
    const body = modalEl.querySelector('#stgfeatShopBody');
    if (!body) return;
    const s = getShopSettings();

    if (!s._exists) {
      body.innerHTML =
        '<div class="stgfeat-placeholder">Run the <code>shop_settings</code> migration to enable shop/RO settings. ' +
        'Until then the RO Board uses the default 7% tax rate.</div>';
      return;
    }

    const pct = s.tax_rate != null ? (s.tax_rate * 100) : '';
    const labor = s.default_labor_rate != null ? s.default_labor_rate : '';
    const cardPct = s.card_fee_pct != null ? (s.card_fee_pct * 100) : '';
    const supplies = s.shop_supplies_default != null ? s.shop_supplies_default : '';
    const hazmat = s.hazmat_default != null ? s.hazmat_default : '';

    // MONEY — editable on Owner/GM only; read-only elsewhere. Covers tax,
    // labor rate, and the three fees (card % + flat shop-supplies/hazmat).
    const moneyBlock = canEditShopMoney ? `
      <div class="stgfeat-field">
        <label>Tax Rate (%)</label>
        <input type="number" id="stgfeatTaxRate" min="0" step="0.01" value="${pct}">
      </div>
      <div class="stgfeat-field">
        <label>Default Labor Rate ($/hr)</label>
        <input type="number" id="stgfeatLaborRate" min="0" step="0.01" value="${labor}" placeholder="not set">
      </div>
      <div class="stgfeat-field">
        <label>Card Processing Fee (%)</label>
        <input type="number" id="stgfeatCardFee" min="0" step="0.01" value="${cardPct}">
      </div>
      <div class="stgfeat-field">
        <label>Shop Supplies ($ flat)</label>
        <input type="number" id="stgfeatSupplies" min="0" step="0.01" value="${supplies}">
      </div>
      <div class="stgfeat-field">
        <label>Hazmat ($ flat)</label>
        <input type="number" id="stgfeatHazmat" min="0" step="0.01" value="${hazmat}">
      </div>` : `
      <div class="stgfeat-field">
        <label>Tax Rate</label>
        <span class="stgfeat-static">${s.tax_rate != null ? (s.tax_rate * 100).toFixed(2) + '%' : '—'}</span>
      </div>
      <div class="stgfeat-field">
        <label>Default Labor Rate</label>
        <span class="stgfeat-static">${s.default_labor_rate != null ? '$' + Number(s.default_labor_rate).toFixed(2) + '/hr' : '—'}</span>
      </div>
      <div class="stgfeat-field">
        <label>Card Processing Fee</label>
        <span class="stgfeat-static">${s.card_fee_pct != null ? (s.card_fee_pct * 100).toFixed(2) + '%' : '—'}</span>
      </div>
      <div class="stgfeat-field">
        <label>Shop Supplies</label>
        <span class="stgfeat-static">${s.shop_supplies_default != null ? '$' + Number(s.shop_supplies_default).toFixed(2) : '—'}</span>
      </div>
      <div class="stgfeat-field">
        <label>Hazmat</label>
        <span class="stgfeat-static">${s.hazmat_default != null ? '$' + Number(s.hazmat_default).toFixed(2) : '—'}</span>
      </div>`;

    // OPERATIONAL — editable on Advisor (and Owner/GM); read-only otherwise.
    const opsBlock = canEditShopOps ? `
      <div class="stgfeat-field stgfeat-field-check">
        <label for="stgfeatShowTech">Show tech on RO</label>
        <input type="checkbox" id="stgfeatShowTech"${s.show_tech_on_ro ? ' checked' : ''}>
      </div>` : `
      <div class="stgfeat-field">
        <label>Show tech on RO</label>
        <span class="stgfeat-static">${s.show_tech_on_ro ? 'Yes' : 'No'}</span>
      </div>`;

    const canSave = canEditShopMoney || canEditShopOps;
    body.innerHTML = moneyBlock + opsBlock +
      (canSave ? '<button type="button" class="stgfeat-btn block" id="stgfeatShopSaveBtn" style="margin-top:6px">Save Shop Settings</button>' : '') +
      '<div class="stgfeat-error" id="stgfeatShopError"></div>' +
      (canEditShopMoney ? '' : '<div class="stgfeat-placeholder" style="margin-top:8px">Tax &amp; labor rate are set on the Owner / GM board.</div>');

    if (canSave) {
      body.querySelector('#stgfeatShopSaveBtn').addEventListener('click', saveShopSettings);
    }
  }

  async function saveShopSettings() {
    const s = getShopSettings();
    if (!s._exists) return;
    const errEl = modalEl.querySelector('#stgfeatShopError');
    const saveBtn = modalEl.querySelector('#stgfeatShopSaveBtn');
    errEl.textContent = '';

    const update = {};
    if (canEditShopMoney) {
      const taxEl = modalEl.querySelector('#stgfeatTaxRate');
      const laborEl = modalEl.querySelector('#stgfeatLaborRate');
      const pct = parseFloat(taxEl.value);
      if (!Number.isFinite(pct) || pct < 0) { errEl.textContent = 'Enter a valid tax rate (%).'; return; }
      update.tax_rate = pct / 100;                       // store as fraction
      const labor = parseFloat(laborEl.value);
      update.default_labor_rate = Number.isFinite(labor) ? labor : null;

      const cardPct = parseFloat(modalEl.querySelector('#stgfeatCardFee').value);
      if (!Number.isFinite(cardPct) || cardPct < 0) { errEl.textContent = 'Enter a valid card fee (%).'; return; }
      update.card_fee_pct = cardPct / 100;               // store as fraction
      const supplies = parseFloat(modalEl.querySelector('#stgfeatSupplies').value);
      update.shop_supplies_default = Number.isFinite(supplies) && supplies >= 0 ? supplies : 0;
      const hazmat = parseFloat(modalEl.querySelector('#stgfeatHazmat').value);
      update.hazmat_default = Number.isFinite(hazmat) && hazmat >= 0 ? hazmat : 0;
    }
    if (canEditShopOps) {
      update.show_tech_on_ro = modalEl.querySelector('#stgfeatShowTech').checked;
    }
    if (Object.keys(update).length === 0) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const { error } = await db.from('shop_settings').update(update).eq('id', s._id);

    if (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Shop Settings';
      console.error('[BoardSettings] shop settings save failed', error);
      errEl.textContent = 'Save failed: ' + error.message;
      return;
    }
    await loadShopSettings();   // refresh cache (+ fires onShopSettingsChanged);
                                // the panel re-renders fresh on next open.
    flashSavedThenClose(saveBtn, 'Save Shop Settings');
  }

  function mountTrigger(mountSelector) {
    const container = document.querySelector(mountSelector);
    if (!container) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stgfeat-trigger-btn';
    btn.id = 'settingsBtn';
    btn.title = 'Settings';
    btn.setAttribute('aria-label', 'Settings');
    btn.innerHTML = `
      <svg class="stgfeat-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
        <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    `;
    btn.addEventListener('click', openModal);
    container.appendChild(btn);
  }

  function init(config) {
    db = config.db;
    targetEl = document.querySelector(config.targetSelector);
    onNameSaved = config.onNameSaved || null;
    canEditShopMoney = !!config.canEditShopMoney;
    canEditShopOps = !!config.canEditShopOps;
    onShopSettingsChanged = config.onShopSettingsChanged || null;
    injectStyles();
    mountTrigger(config.mountSelector);
    loadShopSettings();   // warm the cache so getShopSettings() is current early
  }

  async function refresh(employeeId) {
    currentEmployeeId = employeeId || null;
    if (!currentEmployeeId) { applyBackground(null); return; }
    const { data, error } = await db.from('employees').select('name, background_photo_url').eq('id', currentEmployeeId).maybeSingle();
    if (error) {
      console.error('[BoardSettings] load failed', error);
      return;
    }
    currentName = data ? data.name : null;
    applyBackground(data ? data.background_photo_url : null);
  }

  return { init, refresh, getShopSettings, reloadShopSettings: loadShopSettings };
})();
