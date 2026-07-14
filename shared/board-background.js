// ============================================================
// Shared "Custom board background photo" feature.
//
// Built once, mounted the same way on every board (Advisor,
// Bookkeeping, GM, Owner): lets the logged-in employee upload a
// personal background photo for the main content area, persisted to
// employees.background_photo_url (see migrations/
// 20260714_board_backgrounds.sql) and reloaded on every login.
//
// Fully self-contained — injects its own <style> and modal markup at
// runtime, so it works identically whether or not the host page
// already includes shared/board-shell.css (owner-board.html doesn't).
// Each board only needs:
//
//   <script src="shared/board-background.js"></script>
//   <script>
//     BoardBackground.init({ db, targetSelector: '.main-area', mountSelector: '.sidebar-btn-row' });
//     // once the logged-in employee's id is known:
//     BoardBackground.refresh(employeeId);
//   </script>
// ============================================================

window.BoardBackground = (function () {
  const BUCKET = 'board-backgrounds';
  const OVERLAY = 'rgba(245,246,250,0.86)'; // matches --bg (#f5f6fa) across every board's :root

  let db = null;
  let targetEl = null;
  let currentEmployeeId = null;
  let currentUrl = null;
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
      .bgfeat-target.bgfeat-has-image {
        background-image: linear-gradient(${OVERLAY}, ${OVERLAY}), var(--bgfeat-url);
        background-size: cover;
        background-position: center;
        background-attachment: fixed;
      }
      .bgfeat-trigger-btn {
        display: flex; align-items: center; gap: 6px;
        font-size: 0.7rem; color: #8c93a8;
        text-transform: uppercase; letter-spacing: 1px;
        background: transparent;
        border: 0.5px solid #e2e5ee;
        border-radius: 6px;
        padding: 6px 12px;
        font-family: inherit; cursor: pointer; text-align: left;
        transition: background 0.15s;
      }
      .bgfeat-trigger-btn:hover { background: #f0f1f5; }
      .bgfeat-trigger-icon { width: 14px; height: 14px; flex-shrink: 0; }
      .bgfeat-overlay {
        display: none; position: fixed; inset: 0; background: rgba(20,22,40,0.45);
        z-index: 6000; align-items: center; justify-content: center;
      }
      .bgfeat-overlay.open { display: flex; }
      .bgfeat-box {
        background: #fff; border-radius: 12px; padding: 24px; width: 360px; max-width: 90vw;
        box-shadow: 0 20px 50px rgba(0,0,0,0.25); font-family: 'Segoe UI', system-ui, sans-serif;
      }
      .bgfeat-box h3 { font-size: 1rem; color: #1a1f36; margin: 0 0 16px; }
      .bgfeat-preview {
        width: 100%; height: 130px; border-radius: 8px; background: #f0f1f5;
        background-size: cover; background-position: center;
        display: flex; align-items: center; justify-content: center;
        color: #8c93a8; font-size: 0.78rem; margin-bottom: 14px; overflow: hidden;
      }
      .bgfeat-choose-btn {
        display: block; width: 100%; text-align: center; padding: 9px 0;
        border: 1px dashed #e2e5ee; border-radius: 6px; background: #f0f1f5;
        color: #1a1f36; font-size: 0.82rem; font-weight: 600; cursor: pointer;
        margin-bottom: 14px; font-family: inherit;
      }
      .bgfeat-choose-btn:hover { background: #e2e5ee; }
      .bgfeat-error { color: #dc2626; font-size: 0.78rem; min-height: 16px; margin-bottom: 4px; }
      .bgfeat-btn {
        display: block; width: 100%; padding: 10px 0; border-radius: 6px;
        border: none; background: #5b5ef4; color: #fff; font-weight: 600;
        font-size: 0.85rem; cursor: pointer; margin-top: 8px; font-family: inherit;
        transition: opacity 0.15s;
      }
      .bgfeat-btn:hover { opacity: 0.9; }
      .bgfeat-btn:disabled { opacity: 0.5; cursor: default; }
      .bgfeat-btn.sec { background: #f0f1f5; color: #1a1f36; border: 1px solid #e2e5ee; }
      .bgfeat-btn.danger { background: #fff; color: #dc2626; border: 1px solid #fca5a5; }
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'bgfeat-overlay';
    modalEl.innerHTML = `
      <div class="bgfeat-box">
        <h3>Change Background</h3>
        <div class="bgfeat-preview" id="bgfeatPreview">No photo selected</div>
        <input type="file" accept="image/*" id="bgfeatFileInput" style="display:none">
        <button type="button" class="bgfeat-choose-btn" id="bgfeatChooseBtn">Choose Photo…</button>
        <div class="bgfeat-error" id="bgfeatError"></div>
        <button type="button" class="bgfeat-btn" id="bgfeatSaveBtn" disabled>Save Background</button>
        <button type="button" class="bgfeat-btn danger" id="bgfeatResetBtn">Reset to Default</button>
        <button type="button" class="bgfeat-btn sec" id="bgfeatCancelBtn">Cancel</button>
      </div>
    `;
    document.body.appendChild(modalEl);

    const fileInput = modalEl.querySelector('#bgfeatFileInput');
    const preview = modalEl.querySelector('#bgfeatPreview');
    const saveBtn = modalEl.querySelector('#bgfeatSaveBtn');

    modalEl.querySelector('#bgfeatChooseBtn').addEventListener('click', () => fileInput.click());
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
      saveBtn.disabled = false;
    });

    saveBtn.addEventListener('click', saveBackground);
    modalEl.querySelector('#bgfeatResetBtn').addEventListener('click', resetBackground);
    modalEl.querySelector('#bgfeatCancelBtn').addEventListener('click', closeModal);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });

    return modalEl;
  }

  function openModal() {
    if (!currentEmployeeId) {
      alert('Log in first — your background photo is saved to your employee profile.');
      return;
    }
    ensureModal();
    pendingFile = null;
    modalEl.querySelector('#bgfeatFileInput').value = '';
    modalEl.querySelector('#bgfeatError').textContent = '';
    modalEl.querySelector('#bgfeatSaveBtn').disabled = true;
    const preview = modalEl.querySelector('#bgfeatPreview');
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

  function applyBackground(url) {
    currentUrl = url || null;
    if (!targetEl) return;
    targetEl.classList.add('bgfeat-target');
    if (currentUrl) {
      targetEl.style.setProperty('--bgfeat-url', `url("${currentUrl}")`);
      targetEl.classList.add('bgfeat-has-image');
    } else {
      targetEl.classList.remove('bgfeat-has-image');
      targetEl.style.removeProperty('--bgfeat-url');
    }
  }

  async function saveBackground() {
    if (!pendingFile || !currentEmployeeId) return;
    const errEl = modalEl.querySelector('#bgfeatError');
    const saveBtn = modalEl.querySelector('#bgfeatSaveBtn');
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
      closeModal();
    } catch (err) {
      console.error('[BoardBackground] save failed', err);
      errEl.textContent = 'Save failed: ' + (err.message || 'unknown error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Background';
    }
  }

  async function resetBackground() {
    if (!currentEmployeeId) return;
    const errEl = modalEl.querySelector('#bgfeatError');
    const resetBtn = modalEl.querySelector('#bgfeatResetBtn');
    errEl.textContent = '';
    resetBtn.disabled = true;

    const { error } = await db.from('employees').update({ background_photo_url: null }).eq('id', currentEmployeeId);
    resetBtn.disabled = false;

    if (error) {
      console.error('[BoardBackground] reset failed', error);
      errEl.textContent = 'Reset failed: ' + error.message;
      return;
    }

    applyBackground(null);
    closeModal();
  }

  function mountTrigger(mountSelector) {
    const container = document.querySelector(mountSelector);
    if (!container) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bgfeat-trigger-btn';
    btn.id = 'bgChangeBtn';
    btn.title = 'Change background photo';
    btn.innerHTML = `
      <svg class="bgfeat-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="8.5" cy="10.5" r="1.5" />
        <path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5" />
        <path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3" />
      </svg>
      <span>Background</span>
    `;
    btn.addEventListener('click', openModal);
    container.appendChild(btn);
  }

  function init(config) {
    db = config.db;
    targetEl = document.querySelector(config.targetSelector);
    injectStyles();
    mountTrigger(config.mountSelector);
  }

  async function refresh(employeeId) {
    currentEmployeeId = employeeId || null;
    if (!currentEmployeeId) { applyBackground(null); return; }
    const { data, error } = await db.from('employees').select('background_photo_url').eq('id', currentEmployeeId).maybeSingle();
    if (error) {
      console.error('[BoardBackground] load failed', error);
      return;
    }
    applyBackground(data ? data.background_photo_url : null);
  }

  return { init, refresh };
})();
