// ============================================================
// Shared "Catch this moment" capture — a floating action button on
// every board (all roles). Tapping it lets anyone snap a PHOTO or
// record a SHORT VIDEO CLIP; it uploads to the private
// marketing-content bucket and inserts a marketing_content row, which
// shows up (live) in the Owner board's Marketing Content tab.
//
// Self-contained (injects its own styles + markup), mounted the same
// way on every board:
//   <script src="shared/catch-moment.js"></script>
//   CatchMoment.init({ db, getName: () => CHAT_IDENTITY.name });
//
// Storage rule: only SMALL files here. Clips over the size cap are
// refused with a nudge to put the polished video on YouTube and add
// the link from the Marketing tab. Reuses the Capture-Invoice upload
// flow, INCLUDING its request-ordering fix (reset the file input only
// AFTER the upload attempt finishes — resetting mid-flight can null out
// a camera-captured File's bytes on some mobile browsers).
// ============================================================

window.CatchMoment = (function () {
  const BUCKET = 'marketing-content';
  const MAX_CLIP_MB = 60;   // stored clips stay small; bigger → YouTube

  let db = null;
  let getName = () => null;
  let stylesInjected = false;
  let modalEl = null;
  let busy = false;
  // review-then-save state
  let pendingFile = null;
  let pendingType = null;        // 'photo' | 'video'
  let pendingPreviewUrl = null;  // object URL for the preview element

  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .cm-fab {
        position: fixed; left: 20px; bottom: 20px; z-index: 5000;
        display: flex; align-items: center; gap: 8px;
        background: #5b5ef4; color: #fff; border: none; border-radius: 999px;
        padding: 12px 18px; font-family: 'Segoe UI', system-ui, sans-serif;
        font-size: 0.85rem; font-weight: 700; cursor: pointer;
        box-shadow: 0 8px 24px rgba(91,94,244,0.4); transition: transform 0.15s, opacity 0.15s;
      }
      .cm-fab:hover { transform: translateY(-2px); }
      .cm-fab:active { transform: scale(0.97); }
      .cm-fab .cm-fab-emoji { font-size: 1.1rem; line-height: 1; }
      @media (max-width: 768px) {
        .cm-fab { padding: 12px; }
        .cm-fab .cm-fab-text { display: none; }
      }

      .cm-overlay {
        display: none; position: fixed; inset: 0; background: rgba(20,22,40,0.5);
        z-index: 6100; align-items: center; justify-content: center; padding: 16px;
      }
      .cm-overlay.open { display: flex; }
      .cm-box {
        background: #fff; border-radius: 14px; padding: 22px; width: 360px; max-width: 94vw;
        box-shadow: 0 20px 50px rgba(0,0,0,0.28); font-family: 'Segoe UI', system-ui, sans-serif;
        position: relative;
      }
      .cm-box h3 { font-size: 1.05rem; color: #1a1f36; margin: 0 0 4px; }
      .cm-box .cm-sub { font-size: 0.78rem; color: #8c93a8; margin-bottom: 16px; }
      .cm-close {
        position: absolute; top: 16px; right: 18px; background: none; border: none;
        font-size: 1.3rem; color: #8c93a8; cursor: pointer; line-height: 1;
      }
      .cm-close:hover { color: #1a1f36; }
      .cm-choices { display: flex; gap: 10px; margin-bottom: 14px; }
      .cm-choice {
        flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px;
        padding: 16px 8px; border: 1px solid #e2e5ee; border-radius: 10px; background: #f7f8fa;
        cursor: pointer; font-size: 0.82rem; font-weight: 700; color: #1a1f36;
      }
      .cm-choice:hover { border-color: #5b5ef4; background: #f0f1ff; }
      .cm-choice:disabled { opacity: 0.5; cursor: default; }
      .cm-choice .cm-choice-emoji { font-size: 1.6rem; line-height: 1; }
      .cm-caption {
        width: 100%; box-sizing: border-box; padding: 9px 11px; border: 1px solid #e2e5ee;
        border-radius: 8px; font-size: 0.85rem; font-family: inherit; color: #1a1f36; margin-bottom: 6px;
      }
      .cm-caption:focus { outline: none; border-color: #5b5ef4; }
      .cm-hint { font-size: 0.72rem; color: #8c93a8; }
      .cm-status { font-size: 0.82rem; margin-top: 12px; min-height: 18px; }
      .cm-status.ok { color: #15803d; } .cm-status.err { color: #dc2626; } .cm-status.wait { color: #5b5ef4; }

      /* review-then-save step */
      .cm-preview {
        width: 100%; border-radius: 10px; overflow: hidden; background: #0d0f18; margin-bottom: 12px;
        display: flex; align-items: center; justify-content: center; max-height: 46vh;
      }
      .cm-preview img, .cm-preview video { max-width: 100%; max-height: 46vh; display: block; }
      .cm-review-btns { display: flex; gap: 8px; margin-top: 4px; }
      .cm-btn {
        flex: 1; padding: 10px; border-radius: 8px; border: none; font-family: inherit;
        font-size: 0.83rem; font-weight: 700; cursor: pointer;
      }
      .cm-btn.primary { background: #5b5ef4; color: #fff; }
      .cm-btn.primary:hover { opacity: 0.92; }
      .cm-btn.primary:disabled { opacity: 0.5; cursor: default; }
      .cm-btn.sec { background: #f0f1f5; color: #1a1f36; border: 1px solid #e2e5ee; }
      .cm-btn.danger { background: #fff; color: #dc2626; border: 1px solid #fca5a5; }

      /* Keep the fixed FAB from covering the last sidebar item on desktop
         (gm-board's nav runs longest). Pads the shared shell's scroll
         area so the last link always clears the FAB. Phone layout (drawer
         nav) is untouched. */
      @media (min-width: 769px) {
        .sidebar-scroll { padding-bottom: 84px; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'cm-overlay';
    modalEl.innerHTML = `
      <div class="cm-box">
        <button type="button" class="cm-close" id="cmCloseBtn">&times;</button>
        <h3>Catch this moment</h3>

        <div id="cmChooseScreen">
          <div class="cm-sub">A photo or a short clip — you'll review it before it saves.</div>
          <div class="cm-choices">
            <button type="button" class="cm-choice" id="cmPhotoBtn"><span class="cm-choice-emoji">📷</span>Photo</button>
            <button type="button" class="cm-choice" id="cmVideoBtn"><span class="cm-choice-emoji">🎬</span>Short clip</button>
          </div>
          <div class="cm-hint">Clips are capped at ~60s / ${MAX_CLIP_MB} MB. Bigger, polished videos go on YouTube — add the link from the Marketing tab.</div>
          <div class="cm-status" id="cmChooseStatus"></div>
        </div>

        <div id="cmReviewScreen" style="display:none">
          <div class="cm-sub">Looks good? Add a caption if you like, then Save.</div>
          <div class="cm-preview" id="cmPreview"></div>
          <input type="text" class="cm-caption" id="cmCaption" placeholder="Add a caption (optional)" maxlength="200">
          <div class="cm-review-btns">
            <button type="button" class="cm-btn primary" id="cmSaveBtn">Save</button>
            <button type="button" class="cm-btn sec" id="cmRetakeBtn">Retake</button>
            <button type="button" class="cm-btn danger" id="cmDiscardBtn">Discard</button>
          </div>
          <div class="cm-status" id="cmStatus"></div>
        </div>

        <input type="file" accept="image/*" capture="environment" id="cmPhotoInput" style="display:none">
        <input type="file" accept="video/*" capture="environment" id="cmVideoInput" style="display:none">
      </div>
    `;
    document.body.appendChild(modalEl);

    modalEl.querySelector('#cmCloseBtn').addEventListener('click', closeModal);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });

    modalEl.querySelector('#cmPhotoBtn').addEventListener('click', () => modalEl.querySelector('#cmPhotoInput').click());
    modalEl.querySelector('#cmVideoBtn').addEventListener('click', () => modalEl.querySelector('#cmVideoInput').click());

    modalEl.querySelector('#cmPhotoInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) onFilePicked(file, 'photo');
      e.target.value = '';  // reset AFTER we've grabbed the File (request-ordering fix)
    });
    modalEl.querySelector('#cmVideoInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) onFilePicked(file, 'video');
      e.target.value = '';
    });

    modalEl.querySelector('#cmSaveBtn').addEventListener('click', doSave);
    modalEl.querySelector('#cmRetakeBtn').addEventListener('click', () => {
      const type = pendingType;
      clearPending();
      showChoose();
      modalEl.querySelector(type === 'photo' ? '#cmPhotoInput' : '#cmVideoInput').click();
    });
    modalEl.querySelector('#cmDiscardBtn').addEventListener('click', () => { clearPending(); showChoose(); });
    return modalEl;
  }

  function setStatus(msg, cls) {
    const el = modalEl.querySelector('#cmStatus');
    el.textContent = msg || '';
    el.className = 'cm-status' + (cls ? ' ' + cls : '');
  }
  function setChooseStatus(msg, cls) {
    const el = modalEl.querySelector('#cmChooseStatus');
    el.textContent = msg || '';
    el.className = 'cm-status' + (cls ? ' ' + cls : '');
  }

  function showChoose() {
    modalEl.querySelector('#cmChooseScreen').style.display = 'block';
    modalEl.querySelector('#cmReviewScreen').style.display = 'none';
    setChooseStatus('');
  }
  function showReview() {
    modalEl.querySelector('#cmChooseScreen').style.display = 'none';
    modalEl.querySelector('#cmReviewScreen').style.display = 'block';
    setStatus('');
  }

  function clearPending() {
    pendingFile = null;
    pendingType = null;
    if (pendingPreviewUrl) { URL.revokeObjectURL(pendingPreviewUrl); pendingPreviewUrl = null; }
    if (modalEl) {
      modalEl.querySelector('#cmPreview').innerHTML = '';
      modalEl.querySelector('#cmCaption').value = '';
    }
  }

  function openModal() {
    ensureModal();
    clearPending();
    showChoose();
    modalEl.classList.add('open');
  }
  function closeModal() {
    clearPending();
    if (modalEl) modalEl.classList.remove('open');
  }

  // Validate + preview the picked file, then wait for Save. Nothing is
  // uploaded here — the user reviews the shot (and can Retake/Discard)
  // and only Save commits it to marketing_content.
  function onFilePicked(file, mediaType) {
    const isPhoto = mediaType === 'photo';
    if (isPhoto && !file.type.startsWith('image/')) { setChooseStatus('Please choose an image.', 'err'); return; }
    if (!isPhoto && !file.type.startsWith('video/')) { setChooseStatus('Please choose a video.', 'err'); return; }
    if (!file.size) { setChooseStatus('That file looks empty — try again.', 'err'); return; }
    if (!isPhoto && file.size > MAX_CLIP_MB * 1024 * 1024) {
      setChooseStatus(`That clip is over ${MAX_CLIP_MB} MB. Put it on YouTube (unlisted) and add the link from the Marketing tab.`, 'err');
      return;
    }

    clearPending();
    pendingFile = file;
    pendingType = mediaType;
    pendingPreviewUrl = URL.createObjectURL(file);
    const preview = modalEl.querySelector('#cmPreview');
    preview.innerHTML = isPhoto
      ? `<img src="${pendingPreviewUrl}" alt="preview">`
      : `<video src="${pendingPreviewUrl}" controls playsinline></video>`;
    showReview();
  }

  async function doSave() {
    if (busy || !pendingFile) return;
    const file = pendingFile, mediaType = pendingType, isPhoto = mediaType === 'photo';
    const name = getName && getName();

    busy = true;
    const saveBtn = modalEl.querySelector('#cmSaveBtn');
    saveBtn.disabled = true;
    setStatus(isPhoto ? 'Saving photo…' : 'Saving clip…', 'wait');
    try {
      const id = crypto.randomUUID();
      const now = new Date();
      const yyyyMm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const ext = (file.name.split('.').pop() || (isPhoto ? 'jpg' : 'mp4')).toLowerCase().replace(/[^a-z0-9]/g, '') || (isPhoto ? 'jpg' : 'mp4');
      const folder = isPhoto ? 'photos' : 'clips';
      const path = `${folder}/${yyyyMm}/${id}.${ext}`;

      const { error: upErr } = await db.storage.from(BUCKET).upload(path, file, { upsert: false });
      if (upErr) throw upErr;

      const caption = modalEl.querySelector('#cmCaption').value.trim() || null;
      const { error: insErr } = await db.from('marketing_content').insert({
        media_type: mediaType,
        storage: 'file',
        file_path: path,
        caption,
        captured_by: name || null,
        captured_at: new Date().toISOString(),
      });
      if (insErr) throw insErr;

      setStatus('Saved ✓  It\'ll show in the Owner\'s Marketing tab.', 'ok');
      setTimeout(() => { if (modalEl.classList.contains('open')) closeModal(); }, 1000);
    } catch (err) {
      console.error('[CatchMoment] save failed', err);
      const missing = err && (err.message || '').match(/bucket|not found|does not exist/i);
      setStatus('Save failed: ' + (err.message || 'unknown error') + (missing ? ' (has the migration been run?)' : ''), 'err');
      saveBtn.disabled = false;  // let them retry Save
    } finally {
      busy = false;
    }
  }

  function mountFab() {
    if (document.getElementById('cmFab')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-fab';
    btn.id = 'cmFab';
    btn.title = 'Catch this moment';
    btn.innerHTML = `<span class="cm-fab-emoji">📸</span><span class="cm-fab-text">Catch this moment</span>`;
    btn.addEventListener('click', openModal);
    document.body.appendChild(btn);
  }

  function init(config) {
    db = config.db;
    getName = config.getName || (() => null);
    injectStyles();
    mountFab();
  }

  return { init };
})();
