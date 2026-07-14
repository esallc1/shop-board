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
          <div class="stgfeat-section-label">More Settings</div>
          <div class="stgfeat-placeholder">More options will show up here in a future update.</div>
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

    modalEl.classList.add('open');
  }

  function closeModal() {
    if (modalEl) modalEl.classList.remove('open');
    pendingFile = null;
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

    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';

    if (error) {
      console.error('[BoardSettings] name save failed', error);
      errEl.textContent = 'Save failed: ' + error.message;
      return;
    }

    currentName = name;
    const greetingSpan = document.querySelector('#greetingWrap span');
    if (greetingSpan) greetingSpan.textContent = `Hi, ${name}`;
    if (typeof onNameSaved === 'function') onNameSaved(name);
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
      saveBtn.disabled = true;
    } catch (err) {
      console.error('[BoardSettings] background save failed', err);
      errEl.textContent = 'Save failed: ' + (err.message || 'unknown error');
      saveBtn.disabled = false;
    } finally {
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
    injectStyles();
    mountTrigger(config.mountSelector);
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

  return { init, refresh };
})();
