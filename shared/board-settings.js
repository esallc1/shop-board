// ============================================================
// Shared "Settings" panel — a category layout (left-hand category list +
// right content pane, Tekmetric / Stripe / QuickBooks style) behind a
// single gear-icon trigger, mounted the same way on every board
// (Advisor, Bookkeeping, GM, Owner).
//
// Categories (only the ones a board's permissions allow are shown):
//   • My Profile   — Display Name, Background Photo (personal, everyone)
//   • Shop Profile — name/address/phone/email/website/logo/MV#/legal
//                    (Owner/GM only)
//   • RO & Pricing — tax, labor rate, card fee, supplies, hazmat,
//                    show-tech-on-RO (Owner/GM only)
//   • <board extra> — e.g. Bookkeeping's Categories & Types (onOpenExtra)
//   • [Payments]   — Phase 5 slots a category in here (Owner/GM only)
//
// This is a CONTAINER/LAYOUT refactor: what each setting does and how it
// saves is unchanged — the same save functions (saveName, saveBackground,
// saveShopSettings), validation, and flashSavedThenClose flow, just moved
// into per-category panes. Money categories simply don't appear on boards
// without edit rights (cleaner than the old hide-individual-fields view).
//
// Supersedes the standalone "Background" button (shared/board-
// background.js) — that upload/reset logic against the board-backgrounds
// bucket + employees.background_photo_url column is preserved here.
//
// Fully self-contained — injects its own <style> and modal markup at
// runtime. Each board only needs:
//
//   <script src="shared/board-settings.js"></script>
//   <script>
//     BoardSettings.init({
//       db,
//       targetSelector: '.main-area',       // '.content' on owner-board
//       mountSelector: '.sidebar-btn-row',  // '.header-controls' on owner-board
//       canEditShopMoney, canEditShopOps,   // permission flags
//       onNameSaved: (name) => { CHAT_IDENTITY.name = name; },
//       onOpenExtra: (el) => {...},         // optional board-specific category
//       extraLabel: 'Categories & Types',   // optional label for that category
//     });
//     BoardSettings.refresh(employeeId);    // once the logged-in id is known
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
  let activeCategoryId = null;      // remembers the selected category across opens

  // ── Shop / RO settings (shop_settings table) ──────────────────
  // Single fixed-id row. Permission split is UI-level: which categories
  // render is decided by the flags passed to init(). Money categories
  // (Shop Profile, RO & Pricing) show on Owner/GM only.
  const SHOP_SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
  const SHOP_DEFAULTS = {
    tax_rate: 0.07, default_labor_rate: null, show_tech_on_ro: false,
    card_fee_pct: 0.03, shop_supplies_default: 0, hazmat_default: 0,
    default_diag_fee: null,
  };
  let shopSettingsRow = null;   // raw row, or null if table/row missing
  let canEditShopMoney = false;
  let canEditShopOps = false;
  let onShopSettingsChanged = null;
  let shopLogoFile = null;      // pending logo upload (Owner/GM only)
  let onOpenExtra = null;       // board-specific extra Settings category
  let extraLabel = 'More';      // nav label for that extra category
  // logos live in the existing public board-backgrounds bucket (same
  // anon storage policies already in place), under a shop-logo/ prefix.
  const LOGO_BUCKET = 'board-backgrounds';

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
      // Quick diag-fee receipt default. Nullable + present only post-migration;
      // stays null (no prefill) until the column exists and is set.
      default_diag_fee: shopSettingsRow.default_diag_fee != null ? Number(shopSettingsRow.default_diag_fee) : null,
      // shop profile (Phase 3) — nulls until the migration seeds them
      shop_name: shopSettingsRow.shop_name || null,
      address_line: shopSettingsRow.address_line || null,
      city_state_zip: shopSettingsRow.city_state_zip || null,
      phone: shopSettingsRow.phone || null,
      email: shopSettingsRow.email || null,
      website: shopSettingsRow.website || null,
      logo_url: shopSettingsRow.logo_url || null,
      mv_number: shopSettingsRow.mv_number || null,
      legal_terms: shopSettingsRow.legal_terms || null,
      // true only once the Phase-3 migration added the profile columns —
      // pre-migration the row simply won't carry these keys.
      _hasProfile: ('shop_name' in shopSettingsRow),
      _hasLegal: ('legal_terms' in shopSettingsRow),
      _hasDiagFee: ('default_diag_fee' in shopSettingsRow),
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

  // ── PAYMENT METHODS (Phase 5, Slice 2) — the editable list backing the RO
  // payment picker. Deactivate/reactivate (never hard-delete): inactive drops
  // out of the picker for NEW payments but past payments keep their stored
  // text. Warmed on init like shop_settings; the RO Board reads active methods
  // via getPaymentMethods(), with the constant below as a pre-migration
  // fallback so nothing breaks before the table exists.
  const PAYMENT_METHOD_FALLBACK = [
    { value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' },
    { value: 'koalifi', label: 'Koalifi' }, { value: 'snap', label: 'Snap' },
    { value: 'check', label: 'Check' },
  ];
  let paymentMethodsRows = null;   // all rows (active + inactive), or null if table missing

  async function loadPaymentMethods() {
    try {
      const { data, error } = await db.from('payment_methods').select('*').order('sort_order').order('label');
      if (error) throw error;
      paymentMethodsRows = data || [];
    } catch (err) {
      paymentMethodsRows = null;
      console.warn('[BoardSettings] payment_methods not loaded (using fallback):', err.message || err);
    }
  }

  // Active methods for the picker, as {value,label}. Falls back to the
  // constant when the table is missing/empty (pre-migration).
  function getPaymentMethods() {
    if (!paymentMethodsRows || paymentMethodsRows.length === 0) return PAYMENT_METHOD_FALLBACK.slice();
    return paymentMethodsRows.filter(m => m.active).map(m => ({ value: m.value, label: m.label }));
  }

  // Label for ANY method value (active, inactive, or historical) so past
  // payments always render correctly. Falls back to a title-cased value.
  function paymentMethodLabel(value) {
    if (value == null) return '—';
    const rows = paymentMethodsRows || PAYMENT_METHOD_FALLBACK;
    const hit = rows.find(m => m.value === value);
    if (hit) return hit.label;
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
  }

  function methodSlug(label) {
    return (label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // ── Category nav icons ────────────────────────────────────────
  const ICONS = {
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>',
    shop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>',
    receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  };

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

      /* ── Two-pane category shell ── */
      .stgfeat-box {
        background: #fff; border-radius: 12px; padding: 22px 24px;
        width: 640px; max-width: 92vw; max-height: 85vh;
        box-shadow: 0 20px 50px rgba(0,0,0,0.25); font-family: 'Segoe UI', system-ui, sans-serif;
        position: relative; display: flex; flex-direction: column; overflow: hidden;
      }
      .stgfeat-box h3 { font-size: 1rem; color: #1a1f36; margin: 0 0 14px; flex-shrink: 0; }
      .stgfeat-close {
        position: absolute; top: 18px; right: 20px; background: none; border: none;
        font-size: 1.3rem; color: #8c93a8; cursor: pointer; line-height: 1; padding: 0; z-index: 1;
      }
      .stgfeat-close:hover { color: #1a1f36; }

      .stgfeat-panes { display: flex; flex: 1; min-height: 0; }
      .stgfeat-nav {
        width: 172px; flex-shrink: 0; border-right: 1px solid #eef0f5;
        padding-right: 8px; margin-right: 4px; display: flex; flex-direction: column;
        gap: 2px; overflow-y: auto;
      }
      .stgfeat-nav-item {
        display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
        background: none; border: none; border-radius: 8px; padding: 9px 11px;
        font-family: inherit; font-size: 0.85rem; color: #4a5169; cursor: pointer;
        transition: background 0.12s, color 0.12s;
      }
      .stgfeat-nav-item:hover { background: #f4f5f9; }
      .stgfeat-nav-item.active { background: #eef0fe; color: #3d40d6; font-weight: 600; }
      .stgfeat-nav-icon { width: 15px; height: 15px; flex-shrink: 0; opacity: 0.85; }
      .stgfeat-content { flex: 1; min-width: 0; padding-left: 20px; overflow-y: auto; }
      /* single visible category → drop the one-item sidebar, go full-width */
      .stgfeat-box.stgfeat-solo .stgfeat-nav { display: none; }
      .stgfeat-box.stgfeat-solo .stgfeat-content { padding-left: 0; }

      .stgfeat-cat-title { font-size: 0.95rem; font-weight: 600; color: #1a1f36; margin: 2px 0 3px; }
      .stgfeat-cat-sub { font-size: 0.75rem; color: #8c93a8; margin: 0 0 16px; }

      .stgfeat-placeholder { color: #8c93a8; font-size: 0.8rem; }

      .stgfeat-section { padding: 0 0 16px; margin-bottom: 16px; border-bottom: 1px solid #e2e5ee; }
      .stgfeat-section:last-of-type { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
      .stgfeat-section-label {
        font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.8px;
        color: #8c93a8; font-weight: 700; margin-bottom: 10px;
      }

      .stgfeat-name-row { display: flex; gap: 8px; }
      .stgfeat-name-row input {
        flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid #e2e5ee; border-radius: 6px;
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

      /* ── Payment methods list ── */
      .stgfeat-method-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 8px 0; border-bottom: 1px solid #f0f1f5;
      }
      .stgfeat-method-row.inactive .stgfeat-method-label { color: #8c93a8; }
      .stgfeat-method-label { font-size: 0.88rem; color: #1a1f36; }
      .stgfeat-method-tag {
        font-size: 0.6rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px;
        color: #8c93a8; background: #f0f1f5; border-radius: 8px; padding: 1px 6px; margin-left: 6px;
      }
      .stgfeat-method-toggle { padding: 5px 10px; font-size: 0.75rem; flex-shrink: 0; }
      .stgfeat-method-add { display: flex; gap: 8px; margin-top: 12px; }
      .stgfeat-method-add input {
        flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid #e2e5ee; border-radius: 6px;
        font-size: 0.85rem; font-family: inherit; color: #1a1f36;
      }
      .stgfeat-method-add input:focus { outline: none; border-color: #5b5ef4; }

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
      .stgfeat-content code {
        background: #f0f1f5; border-radius: 4px; padding: 1px 4px; font-size: 0.78rem;
      }
      .stgfeat-pfield { margin-bottom: 10px; }
      .stgfeat-pfield label {
        display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px;
        color: #8c93a8; font-weight: 700; margin-bottom: 4px;
      }
      .stgfeat-pfield input, .stgfeat-pfield textarea {
        width: 100%; padding: 7px 10px; border: 1px solid #e2e5ee; border-radius: 6px;
        font-size: 0.85rem; font-family: inherit; color: #1a1f36; box-sizing: border-box;
      }
      .stgfeat-pfield textarea { resize: vertical; line-height: 1.4; }
      .stgfeat-pfield input:focus, .stgfeat-pfield textarea:focus { outline: none; border-color: #5b5ef4; }
      .stgfeat-logo-row { display: flex; align-items: center; gap: 10px; }
      .stgfeat-logo-preview {
        width: 88px; height: 44px; border: 1px solid #e2e5ee; border-radius: 6px;
        display: flex; align-items: center; justify-content: center; overflow: hidden;
        background: #f7f8fa; color: #8c93a8; font-size: 0.7rem; flex-shrink: 0;
      }
      .stgfeat-logo-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }

      @media (max-width: 600px) {
        .stgfeat-box { width: 94vw; padding: 18px; }
        .stgfeat-panes { flex-direction: column; }
        .stgfeat-nav {
          width: auto; flex-direction: row; overflow-x: auto; gap: 4px;
          border-right: none; border-bottom: 1px solid #eef0f5; padding: 0 0 8px; margin: 0 0 14px;
        }
        .stgfeat-nav-item { white-space: nowrap; }
        .stgfeat-box.stgfeat-solo .stgfeat-nav { display: none; }
        .stgfeat-content { padding-left: 0; }
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
        <div class="stgfeat-panes">
          <nav class="stgfeat-nav" id="stgfeatNav"></nav>
          <div class="stgfeat-content" id="stgfeatContent"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);
    modalEl.querySelector('#stgfeatCloseBtn').addEventListener('click', closeModal);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
    return modalEl;
  }

  // ── Categories: which appear is permission-driven ─────────────
  function getCategories() {
    const cats = [
      { id: 'myprofile',   label: 'My Profile',    icon: ICONS.user,    visible: true,             render: renderMyProfilePane },
      { id: 'shopprofile', label: 'Shop Profile',  icon: ICONS.shop,    visible: canEditShopMoney, render: renderShopProfilePane },
      { id: 'ropricing',   label: 'RO & Pricing',  icon: ICONS.receipt, visible: canEditShopMoney, render: renderRoPricingPane },
      { id: 'payments',    label: 'Payments',      icon: ICONS.card,    visible: canEditShopMoney, render: renderPaymentsPane },
    ];
    if (typeof onOpenExtra === 'function') {
      cats.push({
        id: 'extra', label: extraLabel, icon: ICONS.grid, visible: true,
        render: (el) => { try { onOpenExtra(el); } catch (e) { console.error('[BoardSettings] onOpenExtra failed', e); } },
      });
    }
    return cats.filter(c => c.visible);
  }

  // Build the nav + render the active category's pane. Called on open and
  // whenever a category is picked; re-rendering a pane rewires its handlers.
  function renderPanes() {
    if (!modalEl) return;
    const cats = getCategories();
    const box = modalEl.querySelector('.stgfeat-box');
    const nav = modalEl.querySelector('#stgfeatNav');
    const content = modalEl.querySelector('#stgfeatContent');

    box.classList.toggle('stgfeat-solo', cats.length <= 1);
    if (!cats.some(c => c.id === activeCategoryId)) activeCategoryId = cats.length ? cats[0].id : null;

    nav.innerHTML = cats.map(c =>
      `<button type="button" class="stgfeat-nav-item${c.id === activeCategoryId ? ' active' : ''}" data-cat="${c.id}">
         <span class="stgfeat-nav-icon">${c.icon || ''}</span>${esc(c.label)}
       </button>`).join('');
    nav.querySelectorAll('.stgfeat-nav-item').forEach(b =>
      b.addEventListener('click', () => { activeCategoryId = b.dataset.cat; renderPanes(); }));

    const active = cats.find(c => c.id === activeCategoryId);
    content.innerHTML = '';
    if (active) active.render(content);
  }

  // ── Pane: My Profile (Display Name + Background Photo) ─────────
  function renderMyProfilePane(content) {
    content.innerHTML = `
      <div class="stgfeat-cat-title">My Profile</div>
      <div class="stgfeat-cat-sub">Personal preferences — saved to your employee profile.</div>
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
      </div>`;

    content.querySelector('#stgfeatNameInput').value = currentName || '';
    const preview = content.querySelector('#stgfeatPreview');
    if (currentUrl) { preview.style.backgroundImage = `url("${currentUrl}")`; preview.textContent = ''; }
    else { preview.style.backgroundImage = ''; preview.textContent = 'No photo selected'; }

    content.querySelector('#stgfeatNameSaveBtn').addEventListener('click', saveName);

    const fileInput = content.querySelector('#stgfeatFileInput');
    const bgSaveBtn = content.querySelector('#stgfeatBgSaveBtn');
    content.querySelector('#stgfeatChooseBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      pendingFile = file;
      const reader = new FileReader();
      reader.onload = () => { preview.style.backgroundImage = `url("${reader.result}")`; preview.textContent = ''; };
      reader.readAsDataURL(file);
      bgSaveBtn.disabled = false;
    });
    bgSaveBtn.addEventListener('click', saveBackground);
    content.querySelector('#stgfeatBgResetBtn').addEventListener('click', resetBackground);
  }

  function catHeader(title, sub) {
    return `<div class="stgfeat-cat-title">${title}</div><div class="stgfeat-cat-sub">${sub}</div>`;
  }
  function migrationPlaceholder() {
    return '<div class="stgfeat-placeholder">Run the <code>shop_settings</code> migration to enable shop / RO settings. ' +
      'Until then the RO Board uses the default 7% tax rate.</div>';
  }

  // ── Pane: RO & Pricing (money + show-tech) — Owner/GM only ─────
  function renderRoPricingPane(content) {
    shopLogoFile = null;   // not on this pane; keep a stray logo pick from leaking into a money save
    const s = getShopSettings();
    if (!s._exists) {
      content.innerHTML = catHeader('RO & Pricing', 'Tax, labor, and fees applied on the RO.') + migrationPlaceholder();
      return;
    }
    const pct = s.tax_rate != null ? (s.tax_rate * 100) : '';
    const labor = s.default_labor_rate != null ? s.default_labor_rate : '';
    const diagFee = s.default_diag_fee != null ? s.default_diag_fee : '';
    const cardPct = s.card_fee_pct != null ? (s.card_fee_pct * 100) : '';
    const supplies = s.shop_supplies_default != null ? s.shop_supplies_default : '';
    const hazmat = s.hazmat_default != null ? s.hazmat_default : '';

    // OPERATIONAL — editable when canEditShopOps; read-only otherwise.
    const opsBlock = canEditShopOps ? `
      <div class="stgfeat-field stgfeat-field-check">
        <label for="stgfeatShowTech">Show tech on RO</label>
        <input type="checkbox" id="stgfeatShowTech"${s.show_tech_on_ro ? ' checked' : ''}>
      </div>` : `
      <div class="stgfeat-field">
        <label>Show tech on RO</label>
        <span class="stgfeat-static">${s.show_tech_on_ro ? 'Yes' : 'No'}</span>
      </div>`;

    content.innerHTML =
      catHeader('RO & Pricing', 'Tax, labor, and fees applied on the RO.') +
      `<div class="stgfeat-section">
        <div class="stgfeat-field">
          <label>Tax Rate (%)</label>
          <input type="number" id="stgfeatTaxRate" min="0" step="0.01" value="${pct}">
        </div>
        <div class="stgfeat-field">
          <label>Default Labor Rate ($/hr)</label>
          <input type="number" id="stgfeatLaborRate" min="0" step="0.01" value="${labor}" placeholder="not set">
        </div>
        ${s._hasDiagFee ? `
        <div class="stgfeat-field">
          <label>Default Diagnostic Fee ($)</label>
          <input type="number" id="stgfeatDiagFee" min="0" step="0.01" value="${diagFee}" placeholder="not set">
        </div>` : ''}
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
        </div>
        ${opsBlock}
        <button type="button" class="stgfeat-btn block" id="stgfeatShopSaveBtn" style="margin-top:6px">Save</button>
        <div class="stgfeat-error" id="stgfeatShopError"></div>
      </div>`;

    content.querySelector('#stgfeatShopSaveBtn').addEventListener('click', saveShopSettings);
  }

  // ── Pane: Payments (editable methods, Phase 5 Slice 2) — Owner/GM ─
  // Deactivate/reactivate toggle (never hard-delete) so past payments keep
  // their stored text and an inactive method can come back.
  async function renderPaymentsPane(content) {
    const head = catHeader('Payments', 'Methods shown when recording a payment on an RO. Deactivating hides a method from new payments — past payments keep it.');
    content.innerHTML = head + '<div class="stgfeat-placeholder">Loading…</div>';
    await loadPaymentMethods();
    if (paymentMethodsRows === null) {
      content.innerHTML = head + '<div class="stgfeat-placeholder">Run the <code>payment_methods</code> migration to manage payment methods.</div>';
      return;
    }
    const rows = paymentMethodsRows.slice().sort((a, b) => (a.sort_order - b.sort_order) || String(a.label).localeCompare(String(b.label)));
    const rowsHtml = rows.map(m => `
      <div class="stgfeat-method-row${m.active ? '' : ' inactive'}">
        <span class="stgfeat-method-label">${esc(m.label)}${m.active ? '' : '<span class="stgfeat-method-tag">inactive</span>'}</span>
        <button type="button" class="stgfeat-btn sec stgfeat-method-toggle" data-id="${esc(m.id)}" data-active="${m.active ? '1' : '0'}">${m.active ? 'Deactivate' : 'Reactivate'}</button>
      </div>`).join('');
    content.innerHTML = head +
      `<div class="stgfeat-section">
        <div class="stgfeat-section-label">Payment Methods</div>
        ${rowsHtml}
        <div class="stgfeat-method-add">
          <input type="text" id="stgfeatMethodNew" placeholder="Add a method…">
          <button type="button" class="stgfeat-btn" id="stgfeatMethodAddBtn">Add</button>
        </div>
        <div class="stgfeat-error" id="stgfeatMethodErr"></div>
      </div>`;

    const errEl = content.querySelector('#stgfeatMethodErr');
    const fail = (m) => { if (errEl) errEl.textContent = m; };

    content.querySelectorAll('.stgfeat-method-toggle').forEach(b => {
      b.addEventListener('click', async () => {
        fail('');
        const next = b.dataset.active !== '1';
        const { error } = await db.from('payment_methods').update({ active: next }).eq('id', b.dataset.id);
        if (error) { console.error('[BoardSettings] method toggle failed', error); fail('Update failed: ' + error.message); return; }
        renderPaymentsPane(content);
      });
    });

    content.querySelector('#stgfeatMethodAddBtn').addEventListener('click', async () => {
      fail('');
      const label = content.querySelector('#stgfeatMethodNew').value.trim();
      if (!label) return;
      const value = methodSlug(label);
      if (!value) { fail('Enter a valid name.'); return; }
      const maxSort = rows.reduce((mx, r) => Math.max(mx, r.sort_order || 0), -1);
      const { error } = await db.from('payment_methods').insert({ value, label, active: true, sort_order: maxSort + 1 });
      if (error) {
        console.error('[BoardSettings] method add failed', error);
        fail(/duplicate|unique/i.test(error.message || '') ? 'That method already exists.' : 'Add failed: ' + error.message);
        return;
      }
      renderPaymentsPane(content);
    });
  }

  // ── Pane: Shop Profile (invoice header + legal footer) — Owner/GM ─
  function renderShopProfilePane(content) {
    shopLogoFile = null;
    const s = getShopSettings();
    if (!s._exists) {
      content.innerHTML = catHeader('Shop Profile', 'Appears on the printed Estimate / RO / Invoice.') + migrationPlaceholder();
      return;
    }
    if (!s._hasProfile) {
      content.innerHTML = catHeader('Shop Profile', 'Appears on the printed Estimate / RO / Invoice.') +
        '<div class="stgfeat-placeholder">Run the Phase-3 print-fields migration to enable the shop profile.</div>';
      return;
    }
    const pf = (id, label, val, type) =>
      `<div class="stgfeat-pfield"><label>${label}</label><input type="${type || 'text'}" id="${id}" value="${esc(val || '')}"></div>`;

    content.innerHTML =
      catHeader('Shop Profile', 'Appears on the printed Estimate / RO / Invoice.') +
      `<div class="stgfeat-section">
        ${pf('stgfeatShopName', 'Shop Name', s.shop_name)}
        ${pf('stgfeatAddress', 'Address', s.address_line)}
        ${pf('stgfeatCityStateZip', 'City, State ZIP', s.city_state_zip)}
        ${pf('stgfeatPhone', 'Phone', s.phone, 'tel')}
        ${pf('stgfeatEmail', 'Email', s.email, 'email')}
        ${pf('stgfeatWebsite', 'Website', s.website)}
        ${pf('stgfeatMvNumber', 'MV Number', s.mv_number)}
        <div class="stgfeat-pfield">
          <label>Logo</label>
          <div class="stgfeat-logo-row">
            <div class="stgfeat-logo-preview" id="stgfeatLogoPreview">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="logo">` : 'No logo'}</div>
            <input type="file" accept="image/*" id="stgfeatLogoFile" style="display:none">
            <button type="button" class="stgfeat-btn sec" id="stgfeatLogoChoose">Choose logo…</button>
          </div>
        </div>
        ${s._hasLegal ? `<div class="stgfeat-pfield">
          <label>Legal Terms (invoice footer)</label>
          <textarea id="stgfeatLegalTerms" rows="5" placeholder="Lien / authorization / warranty paragraph printed as small print on the invoice">${esc(s.legal_terms || '')}</textarea>
        </div>` : ''}
        <button type="button" class="stgfeat-btn block" id="stgfeatShopSaveBtn" style="margin-top:6px">Save</button>
        <div class="stgfeat-error" id="stgfeatShopError"></div>
      </div>`;

    const fileInput = content.querySelector('#stgfeatLogoFile');
    const preview = content.querySelector('#stgfeatLogoPreview');
    content.querySelector('#stgfeatLogoChoose').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      shopLogoFile = f;
      const reader = new FileReader();
      reader.onload = () => { preview.innerHTML = `<img src="${reader.result}" alt="logo">`; };
      reader.readAsDataURL(f);
    });
    content.querySelector('#stgfeatShopSaveBtn').addEventListener('click', saveShopSettings);
  }

  function openModal() {
    if (!currentEmployeeId) {
      alert('Log in first — Settings are saved to your employee profile.');
      return;
    }
    ensureModal();
    pendingFile = null;
    shopLogoFile = null;

    renderPanes();
    // refresh the shop cache in case another board changed it; re-render if a
    // shop pane is the one on screen so it shows the latest values.
    loadShopSettings().then(() => {
      if (activeCategoryId === 'shopprofile' || activeCategoryId === 'ropricing') renderPanes();
    });

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
    if (preview) { preview.style.backgroundImage = ''; preview.textContent = 'No photo selected'; }
  }

  // ── Shop / RO settings: save ──────────────────────────────────
  // Same validation + upsert + flashSavedThenClose flow as before. Now that
  // Shop Profile and RO & Pricing are separate category panes hitting the
  // same shop_settings row, each field is read only when its element is
  // actually on screen — so saving one pane never blanks the other's fields.
  async function saveShopSettings() {
    const s = getShopSettings();
    if (!s._exists) return;
    const errEl = modalEl.querySelector('#stgfeatShopError');
    const saveBtn = modalEl.querySelector('#stgfeatShopSaveBtn');
    errEl.textContent = '';

    const update = {};
    if (canEditShopMoney) {
      // money fields — present only while the RO & Pricing pane is open
      const taxEl = modalEl.querySelector('#stgfeatTaxRate');
      if (taxEl) {
        const pct = parseFloat(taxEl.value);
        if (!Number.isFinite(pct) || pct < 0) { errEl.textContent = 'Enter a valid tax rate (%).'; return; }
        update.tax_rate = pct / 100;                       // store as fraction
        const labor = parseFloat(modalEl.querySelector('#stgfeatLaborRate').value);
        update.default_labor_rate = Number.isFinite(labor) ? labor : null;

        const diagEl = s._hasDiagFee ? modalEl.querySelector('#stgfeatDiagFee') : null;
        if (diagEl) {   // only write the column when the migration has added it
          const diag = parseFloat(diagEl.value);
          update.default_diag_fee = (Number.isFinite(diag) && diag >= 0) ? diag : null;
        }

        const cardPct = parseFloat(modalEl.querySelector('#stgfeatCardFee').value);
        if (!Number.isFinite(cardPct) || cardPct < 0) { errEl.textContent = 'Enter a valid card fee (%).'; return; }
        update.card_fee_pct = cardPct / 100;               // store as fraction
        const supplies = parseFloat(modalEl.querySelector('#stgfeatSupplies').value);
        update.shop_supplies_default = Number.isFinite(supplies) && supplies >= 0 ? supplies : 0;
        const hazmat = parseFloat(modalEl.querySelector('#stgfeatHazmat').value);
        update.hazmat_default = Number.isFinite(hazmat) && hazmat >= 0 ? hazmat : 0;
      }

      // shop profile fields — present only while the Shop Profile pane is open
      if (s._hasProfile && modalEl.querySelector('#stgfeatShopName')) {
        const t = (id) => { const el = modalEl.querySelector(id); return el && el.value.trim() ? el.value.trim() : null; };
        update.shop_name = t('#stgfeatShopName');
        update.address_line = t('#stgfeatAddress');
        update.city_state_zip = t('#stgfeatCityStateZip');
        update.phone = t('#stgfeatPhone');
        update.email = t('#stgfeatEmail');
        update.website = t('#stgfeatWebsite');
        update.mv_number = t('#stgfeatMvNumber');
      }
      if (s._hasLegal && modalEl.querySelector('#stgfeatLegalTerms')) {
        const legalEl = modalEl.querySelector('#stgfeatLegalTerms');
        update.legal_terms = legalEl.value.trim() ? legalEl.value.trim() : null;
      }
    }
    if (canEditShopOps) {
      const showTechEl = modalEl.querySelector('#stgfeatShowTech');
      if (showTechEl) update.show_tech_on_ro = showTechEl.checked;
    }
    if (Object.keys(update).length === 0 && !shopLogoFile) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    // upload a new logo first (if chosen); on failure, keep the panel open.
    if (canEditShopMoney && s._hasProfile && shopLogoFile) {
      try {
        const ext = (shopLogoFile.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
        const path = `shop-logo/${Date.now()}.${ext}`;
        const { error: upErr } = await db.storage.from(LOGO_BUCKET).upload(path, shopLogoFile, { upsert: true });
        if (upErr) throw upErr;
        const { data: pub } = db.storage.from(LOGO_BUCKET).getPublicUrl(path);
        update.logo_url = pub.publicUrl;
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        console.error('[BoardSettings] logo upload failed', err);
        errEl.textContent = 'Logo upload failed: ' + (err.message || 'unknown error');
        return;
      }
    }

    const { error } = await db.from('shop_settings').update(update).eq('id', s._id);

    if (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      console.error('[BoardSettings] shop settings save failed', error);
      errEl.textContent = 'Save failed: ' + error.message;
      return;
    }
    await loadShopSettings();   // refresh cache (+ fires onShopSettingsChanged);
                                // the pane re-renders fresh on next open.
    flashSavedThenClose(saveBtn, 'Save');
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
    onOpenExtra = config.onOpenExtra || null;
    extraLabel = config.extraLabel || 'More';
    injectStyles();
    mountTrigger(config.mountSelector);
    loadShopSettings();       // warm the cache so getShopSettings() is current early
    loadPaymentMethods();     // warm the payment-method cache for the RO picker
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

  return {
    init, refresh, getShopSettings, reloadShopSettings: loadShopSettings,
    getPaymentMethods, paymentMethodLabel, reloadPaymentMethods: loadPaymentMethods,
  };
})();
