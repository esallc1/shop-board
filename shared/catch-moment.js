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
        <div class="cm-sub">A photo or a short clip — it lands in the Owner's Marketing tab.</div>
        <div class="cm-choices">
          <button type="button" class="cm-choice" id="cmPhotoBtn"><span class="cm-choice-emoji">📷</span>Photo</button>
          <button type="button" class="cm-choice" id="cmVideoBtn"><span class="cm-choice-emoji">🎬</span>Short clip</button>
        </div>
        <input type="text" class="cm-caption" id="cmCaption" placeholder="Add a caption (optional)" maxlength="200">
        <div class="cm-hint">Clips are capped at ~60s / ${MAX_CLIP_MB} MB. Bigger, polished videos go on YouTube — add the link from the Marketing tab.</div>
        <input type="file" accept="image/*" capture="environment" id="cmPhotoInput" style="display:none">
        <input type="file" accept="video/*" capture="environment" id="cmVideoInput" style="display:none">
        <div class="cm-status" id="cmStatus"></div>
      </div>
    `;
    document.body.appendChild(modalEl);

    modalEl.querySelector('#cmCloseBtn').addEventListener('click', closeModal);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });

    modalEl.querySelector('#cmPhotoBtn').addEventListener('click', () => modalEl.querySelector('#cmPhotoInput').click());
    modalEl.querySelector('#cmVideoBtn').addEventListener('click', () => modalEl.querySelector('#cmVideoInput').click());

    modalEl.querySelector('#cmPhotoInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) await handleUpload(file, 'photo');
      e.target.value = '';  // reset AFTER (request-ordering fix)
    });
    modalEl.querySelector('#cmVideoInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) await handleUpload(file, 'video');
      e.target.value = '';
    });
    return modalEl;
  }

  function setStatus(msg, cls) {
    const el = modalEl.querySelector('#cmStatus');
    el.textContent = msg || '';
    el.className = 'cm-status' + (cls ? ' ' + cls : '');
  }
  function setBusy(b) {
    busy = b;
    modalEl.querySelector('#cmPhotoBtn').disabled = b;
    modalEl.querySelector('#cmVideoBtn').disabled = b;
  }

  function openModal() {
    ensureModal();
    modalEl.querySelector('#cmCaption').value = '';
    setStatus('');
    setBusy(false);
    modalEl.classList.add('open');
  }
  function closeModal() { if (modalEl) modalEl.classList.remove('open'); }

  async function handleUpload(file, mediaType) {
    if (busy) return;
    const name = getName && getName();
    const isPhoto = mediaType === 'photo';
    if (isPhoto && !file.type.startsWith('image/')) { setStatus('Please choose an image.', 'err'); return; }
    if (!isPhoto && !file.type.startsWith('video/')) { setStatus('Please choose a video.', 'err'); return; }
    if (!file.size) { setStatus('That file looks empty — try again.', 'err'); return; }
    if (!isPhoto && file.size > MAX_CLIP_MB * 1024 * 1024) {
      setStatus(`That clip is over ${MAX_CLIP_MB} MB. Put it on YouTube (unlisted) and add the link from the Marketing tab.`, 'err');
      return;
    }

    setBusy(true);
    setStatus(isPhoto ? 'Uploading photo…' : 'Uploading clip…', 'wait');
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
      modalEl.querySelector('#cmCaption').value = '';
      setTimeout(() => { if (modalEl.classList.contains('open')) closeModal(); }, 1200);
    } catch (err) {
      console.error('[CatchMoment] upload failed', err);
      const missing = err && (err.message || '').match(/bucket|not found|does not exist/i);
      setStatus('Upload failed: ' + (err.message || 'unknown error') + (missing ? ' (has the migration been run?)' : ''), 'err');
    } finally {
      setBusy(false);
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
