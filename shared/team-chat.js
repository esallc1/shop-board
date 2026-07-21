/* ============================================================
   team-chat.js — single shared Team Chat component.

   Slice 3b (this file) — CONVERSATION-DRIVEN rewrite. Chat is now an
   inbox of conversations (the Slack/WhatsApp shape), not the old fixed
   role-pair channel strings.

   Data model (migrations/20260720_chat_conversations.sql, APPLIED):
     chat_conversations(id, type 'dm'|'group', title, dm_key, ...)
     chat_members(conversation_id, member_name, member_role)   PK(conv,name)
     chat_messages.conversation_id   — new rows set this, leave channel null
     chat_reads   PK(conversation_id, reader_name) — last_read_at per person

   UI shape:
     • DEFAULT = INBOX: the conversations I'm a member of, newest-activity
       first — display name, last-message preview, time, unread badge.
       Group name = title; DM name = the OTHER member's name.
     • TAP A ROW = THREAD: that conversation's messages oldest→newest,
       input box, a back control to return to the inbox. Opening marks read.
     • SEND writes conversation_id (channel null). Push is fire-and-forget
       and fully guarded (3d rewires it to conversation_id).
     • REALTIME: one chat_messages INSERT subscription, filtered client-side
       by my membership. Open thread → append live; other conv → bump inbox
       row + unread + toast. Refetch membership+inbox on every (re)connect.

   Identity is read LIVE via config.getIdentity() → {role, name}; member
   lookup keys on name (never hardcode role strings — the bookkeeper's role
   is stored as 'bookkeeping'). Boards still pass their old per-board config
   (mode / badgeId / isSurfaceVisible); the obsolete `channels` and
   `ownerNameChannelKey` keys are accepted but IGNORED — conversations are
   derived from chat_members now.

   Markup contract (unchanged, identical on every board):
     #chat-channels   — repurposed as the thread back-bar (hidden in inbox)
     #chat-messages   — swaps between inbox list and thread messages
     #chat-input #chat-send #emoji-btn #emoji-popover   — thread input row
     #chat-panel      — the panel root (gets a chat-mode-* + chat-view-* class)

   initTeamChat(config) returns { refetch, resubscribe, getChannel, onSurfaceShown }.
   ============================================================ */
function initTeamChat(config) {
  const db = config.db;
  // Read identity LIVE at every use — boards REASSIGN CHAT_IDENTITY to a new
  // object once the session resolves, so a reference captured at init would
  // stay pinned to the initial {name:null}. config.getIdentity() always
  // reflects the board's current value.
  const getIdentity = () =>
    (typeof config.getIdentity === 'function' ? config.getIdentity() : config.identity) || {};
  const badgeId = config.badgeId || 'teamchat-unread-badge';
  const isSurfaceVisible = config.isSurfaceVisible || (() => true);

  // ── state ──
  let currentConvId = null;         // null = inbox view; else the open thread
  let myConversations = [];         // enriched, sorted newest-activity first
  let convById = {};                // id -> enriched conversation
  let unreadByConv = {};            // id -> unread count
  let threadMessages = [];          // messages of the open thread
  let chatRealtimeChannel = null;
  let chatAudioCtx = null;
  let compose = null;               // compose-flow state (Slice 3c): {step, groupName, roster}
  const signedUrlCache = {};        // attachment_path -> signed URL (Slice 4a)

  const ATTACH_BUCKET = 'crisdata-attachments';   // private; read via createSignedUrl
  const ATTACH_MAX_BYTES = 10 * 1024 * 1024;      // ~10MB per attachment

  // The office roster the compose pickers draw from. These are role STRINGS as
  // stored in employees.role (note the bookkeeper's role is 'bookkeeping', not
  // 'bookkeeper'); person NAMES are always resolved live from employees, never
  // hardcoded. Techs are never in this set, so they never appear in a picker.
  const OFFICE_ROLES = ['owner', 'manager', 'advisor', 'bookkeeping'];

  // ── durable read-state (chat_reads) — with defensive in-memory fallback ──
  let readAvailable = true;         // flips false if chat_reads ever looks unmigrated
  const lastReadAt = {};            // conversation_id -> ISO last_read_at

  function esc(s) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // Attachment label (Slice 4a) — keep in sync with attachmentLabel in
  // api/_push-recipients.js so the lock-screen push and the inbox line match.
  function attachmentLabel(kind, name) {
    if (kind === 'photo') return '📷 Photo';
    if (kind === 'voice') return '🎤 Voice message';
    if (kind === 'file') { const n = name && name.trim(); return '📎 ' + (n || 'File'); }
    return '';
  }
  // What an inbox/preview line shows for a message: caption if present, else the
  // attachment label (so an attachment-only message never renders blank).
  function previewTextFor(msg) {
    if (!msg) return '';
    const caption = (msg.message || '').trim();
    if (caption) return caption;
    if (msg.attachment_kind) return attachmentLabel(msg.attachment_kind, msg.attachment_name);
    return msg.message || '';
  }
  function formatChatTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  // Inbox timestamp: time today, weekday within a week, else short date.
  function formatInboxTime(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
    return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
  }
  function isMissingTable(err) {
    const code = (err && err.code) || '', msg = (err && err.message) || '';
    return code === '42P01' || code === 'PGRST205' ||
      /relation .* does not exist/i.test(msg) || /could not find the table/i.test(msg);
  }

  // ── one-time CSS injection (keeps 3b styling identical across all boards,
  //    including owner-board which has its own inline chat CSS) ──
  (function injectChatCss() {
    if (document.getElementById('cd-teamchat-3b-css')) return;
    const css = `
.chat-panel.chat-view-inbox .chat-input-row,
.chat-panel.chat-view-compose .chat-input-row { display:none; }
.chat-panel.chat-view-inbox #chat-channels {
  display:flex; align-items:center; justify-content:flex-end; padding:6px 10px;
}
.chat-panel.chat-view-thread #chat-channels,
.chat-panel.chat-view-compose #chat-channels {
  display:flex; align-items:center; gap:8px; padding:8px 10px;
}
.chat-compose-btn {
  border:none; background:transparent; cursor:pointer;
  font-size:1.15rem; line-height:1; color:var(--accent);
  width:32px; height:32px; border-radius:8px; flex:0 0 auto;
  display:flex; align-items:center; justify-content:center;
}
.chat-compose-btn:hover { background:#eef0f7; }
.chat-back-btn {
  border:none; background:transparent; cursor:pointer;
  font-size:1.6rem; line-height:1; color:var(--accent);
  width:30px; height:30px; border-radius:8px; flex:0 0 auto;
  display:flex; align-items:center; justify-content:center;
}
.chat-back-btn:hover { background:#eef0f7; }
.chat-thread-title {
  font-weight:700; font-size:0.85rem; color:var(--text);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
/* compose (Slice 3c) */
.chat-compose { display:flex; flex-direction:column; gap:8px; }
.chat-compose-hint { font-size:0.78rem; color:var(--muted); font-weight:600; padding:2px 2px 0; }
.chat-compose-err { color:#dc2626; font-size:0.76rem; min-height:14px; padding:0 2px; }
.chat-compose-choice {
  display:flex; align-items:center; gap:12px; width:100%; text-align:left;
  padding:12px 14px; background:#fff; border:1px solid var(--border);
  border-radius:10px; cursor:pointer; font-family:inherit;
}
.chat-compose-choice:hover { background:#f4f6fb; }
.chat-compose-ic { font-size:1.5rem; flex:0 0 auto; }
.chat-compose-choice b { font-size:0.88rem; color:var(--text); }
.chat-compose-choice small { display:block; color:var(--muted); font-size:0.72rem; margin-top:1px; }
.chat-roster { display:flex; flex-direction:column; gap:6px; }
.chat-roster-row {
  display:flex; align-items:center; gap:10px; width:100%; text-align:left;
  padding:9px 12px; background:#fff; border:1px solid var(--border);
  border-radius:10px; cursor:pointer; font-family:inherit;
}
.chat-roster-row:hover { background:#f4f6fb; }
.chat-roster-l { display:flex; align-items:center; gap:10px; flex:1; min-width:0; }
.chat-roster-main { display:flex; flex-direction:column; min-width:0; }
.chat-roster-name { font-weight:700; font-size:0.84rem; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chat-roster-role { font-size:0.72rem; color:var(--muted); text-transform:capitalize; }
.chat-roster-row input[type=checkbox] { margin-left:auto; width:18px; height:18px; flex:0 0 auto; }
.chat-group-name {
  padding:9px 11px; border-radius:8px; border:1px solid var(--border);
  font-family:inherit; font-size:0.85rem; background:#fff; color:var(--text); outline:none;
}
.chat-group-name:focus { border-color:var(--accent); }
.chat-compose-next, .chat-compose-create {
  background:var(--accent); color:#fff; border:none; border-radius:8px;
  padding:11px; font-weight:700; cursor:pointer; font-family:inherit; font-size:0.82rem; margin-top:2px;
}
.chat-compose-next:hover, .chat-compose-create:hover { opacity:0.9; }
.chat-inbox { display:flex; flex-direction:column; margin:-12px; }
.chat-inbox-empty { padding:24px 16px; text-align:center; color:var(--muted); font-size:0.83rem; }
.chat-inbox-row {
  display:flex; align-items:center; gap:10px;
  width:100%; text-align:left; cursor:pointer; font-family:inherit;
  padding:11px 14px; background:#fff; border:none; border-bottom:1px solid var(--border);
}
.chat-inbox-row:hover { background:#f4f6fb; }
.chat-inbox-avatar {
  flex:0 0 auto; width:38px; height:38px; border-radius:50%;
  background:var(--accent); color:#fff; font-weight:700; font-size:0.95rem;
  display:flex; align-items:center; justify-content:center;
}
.chat-inbox-avatar.is-group { background:#6b7280; }
.chat-inbox-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.chat-inbox-top { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.chat-inbox-name {
  font-weight:700; font-size:0.85rem; color:var(--text);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.chat-inbox-time { flex:0 0 auto; font-size:0.66rem; color:var(--muted); }
.chat-inbox-preview {
  font-size:0.78rem; color:var(--muted);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.chat-inbox-none { font-style:italic; }
.chat-inbox-badge {
  flex:0 0 auto; min-width:18px; height:18px; padding:0 5px; border-radius:20px;
  background:#ef4444; color:#fff; font-size:0.66rem; font-weight:700;
  display:flex; align-items:center; justify-content:center;
}
/* attachments (Slice 4a) */
.chat-attach-btn {
  width:34px; height:34px; border-radius:50%; flex:0 0 auto;
  background:#f0f1f7; border:1px solid var(--border); cursor:pointer;
  font-size:1rem; display:flex; align-items:center; justify-content:center; transition:background .15s;
}
.chat-attach-btn:hover { background:#eef0f7; }
.chat-attach-btn:disabled { opacity:.55; cursor:default; }
.chat-att-photo-wrap { display:block; }
.chat-att-photo {
  display:block; max-width:200px; max-height:240px; width:auto; height:auto;
  border-radius:12px; border:1px solid var(--border); object-fit:cover; background:#fff;
}
.chat-msg.me .chat-att-photo { border-color:rgba(255,255,255,0.45); }
.chat-att-photo-loading {
  width:160px; height:110px; border-radius:12px; border:1px dashed var(--border);
  display:flex; align-items:center; justify-content:center;
  color:var(--muted); font-size:0.74rem; background:#fff;
}
.chat-att-file { font-weight:600; }
/* Desktop: the in-page tab boards' chat fills the content area instead of
   floating as a short phone-width card. Scoped to .chat-mode-tab so the
   owner-board floating FAB panel (.chat-mode-panel) keeps its compact size. */
@media (min-width:768px) {
  .chat-panel.chat-mode-tab {
    height: calc(100vh - 160px); min-height: 520px; max-height: none;
  }
}`;
    const el = document.createElement('style');
    el.id = 'cd-teamchat-3b-css';
    el.textContent = css;
    document.head.appendChild(el);
  })();

  // ── alert audio (synthesized beep; no external asset) ──
  function unlockChatAudio() {
    if (!chatAudioCtx) {
      try { chatAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    }
    if (chatAudioCtx.state === 'suspended') chatAudioCtx.resume().catch(() => {});
  }
  ['click', 'keydown', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, unlockChatAudio, { once: true, passive: true });
  });
  function playChatAlertSound() {
    if (!chatAudioCtx) {
      try { chatAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    }
    const fire = () => {
      const osc = chatAudioCtx.createOscillator();
      const gain = chatAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.16, chatAudioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, chatAudioCtx.currentTime + 0.3);
      osc.connect(gain).connect(chatAudioCtx.destination);
      osc.start();
      osc.stop(chatAudioCtx.currentTime + 0.3);
    };
    if (chatAudioCtx.state === 'suspended') chatAudioCtx.resume().then(fire).catch(() => {});
    else fire();
  }

  // ── toast ──
  function ensureChatToastContainer() {
    let box = document.getElementById('chat-toast-container');
    if (!box) {
      box = document.createElement('div');
      box.id = 'chat-toast-container';
      box.className = 'chat-toast-container';
      document.body.appendChild(box);
    }
    return box;
  }
  function showChatToast(rec) {
    const box = ensureChatToastContainer();
    const conv = convById[rec.conversation_id];
    const label = conv ? conv.displayName : 'Team Chat';
    const el = document.createElement('div');
    el.className = 'chat-toast';
    el.innerHTML = `
      <div class="chat-toast-channel">${esc(label)}</div>
      <div class="chat-toast-sender">${esc(rec.sender_name)}</div>
      <div class="chat-toast-msg">${esc(previewTextFor(rec))}</div>
    `;
    el.addEventListener('click', () => {
      el.remove();
      openThread(rec.conversation_id);   // jump straight to the conversation
    });
    box.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ── unread badge (sum across conversations) ──
  function updateChatUnreadBadge() {
    const badge = document.getElementById(badgeId);
    if (!badge) return;
    const total = Object.values(unreadByConv).reduce((a, b) => a + (b || 0), 0);
    if (total > 0) {
      badge.textContent = total > 9 ? '9+' : String(total);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // ── view switching ──
  // mode: 'inbox' (compose entry point) | 'thread' | 'compose'.
  // backFn overrides the back-control target (compose steps chain back through
  // themselves; thread/compose default to the inbox).
  function setChrome(mode, title, backFn) {
    const panel = document.getElementById('chat-panel');
    if (panel) {
      panel.classList.toggle('chat-view-inbox', mode === 'inbox');
      panel.classList.toggle('chat-view-thread', mode === 'thread');
      panel.classList.toggle('chat-view-compose', mode === 'compose');
    }
    const nav = document.getElementById('chat-channels');
    if (!nav) return;
    if (mode === 'inbox') {
      // WhatsApp-style compose entry: a new-message pencil in the inbox header.
      nav.innerHTML = `<button class="chat-compose-btn" type="button" aria-label="New message" title="New message">✎</button>`;
      const c = nav.querySelector('.chat-compose-btn');
      if (c) c.addEventListener('click', openCompose);
    } else {
      nav.innerHTML =
        `<button class="chat-back-btn" type="button" aria-label="Back">‹</button>` +
        `<span class="chat-thread-title">${esc(title || '')}</span>`;
      const back = nav.querySelector('.chat-back-btn');
      if (back) back.addEventListener('click', backFn || backToInbox);
    }
  }

  // ── inbox ──
  // Repaint the inbox only when it's actually the visible screen — not while a
  // thread is open (currentConvId set) or the compose flow owns #chat-messages.
  function renderInboxIfVisible() { if (currentConvId === null && !compose) renderInbox(); }

  function renderInbox() {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const me = getIdentity();
    if (!myConversations.length) {
      box.innerHTML = `<div class="chat-inbox-empty">${me.name ? 'No conversations yet.' : 'Loading…'}</div>`;
      return;
    }
    box.innerHTML = `<div class="chat-inbox">` + myConversations.map(c => {
      const preview = c.lastMsg
        ? `${c.lastMsg.sender_name === me.name ? 'You' : esc(c.lastMsg.sender_name)}: ${esc(truncate(previewTextFor(c.lastMsg), 42))}`
        : `<span class="chat-inbox-none">No messages yet</span>`;
      const time = c.lastMsg ? formatInboxTime(c.lastAt) : '';
      const badge = c.unread > 0 ? `<span class="chat-inbox-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
      const initial = (c.displayName || '?').trim().charAt(0).toUpperCase();
      return `<button class="chat-inbox-row" data-conv="${c.id}">
        <span class="chat-inbox-avatar ${c.type === 'group' ? 'is-group' : ''}">${c.type === 'group' ? '👥' : esc(initial)}</span>
        <span class="chat-inbox-main">
          <span class="chat-inbox-top">
            <span class="chat-inbox-name">${esc(c.displayName)}</span>
            <span class="chat-inbox-time">${time}</span>
          </span>
          <span class="chat-inbox-preview">${preview}</span>
        </span>
        ${badge}
      </button>`;
    }).join('') + `</div>`;
    box.querySelectorAll('[data-conv]').forEach(btn =>
      btn.addEventListener('click', () => openThread(btn.dataset.conv)));
    box.scrollTop = 0;
  }

  async function loadReadState(ids) {
    if (!readAvailable || !getIdentity().name || !ids.length) return;
    const { data, error } = await db.from('chat_reads')
      .select('conversation_id, last_read_at')
      .eq('reader_name', getIdentity().name);
    if (error) {
      if (isMissingTable(error)) readAvailable = false;
      else console.warn('[Chat] read load failed', error.message);
      return;
    }
    (data || []).forEach(r => { if (r.conversation_id) lastReadAt[r.conversation_id] = r.last_read_at; });
  }

  // Load my conversations + previews + unread, then render the inbox.
  // Only touches the inbox DOM when the inbox is the active view; always
  // refreshes state + the unread badge (so a bumped badge is correct even
  // while a thread is open).
  async function loadInbox() {
    const me = getIdentity();
    if (!me.name) return;

    const { data: mem, error: memErr } = await db.from('chat_members')
      .select('conversation_id').eq('member_name', me.name);
    if (memErr) { console.error('[Chat] membership load failed', memErr); return; }
    const ids = (mem || []).map(m => m.conversation_id);
    if (!ids.length) {
      myConversations = []; convById = {}; unreadByConv = {};
      renderInboxIfVisible(); updateChatUnreadBadge();
      return;
    }

    const [{ data: convs, error: cErr }, { data: allMem }] = await Promise.all([
      db.from('chat_conversations').select('*').in('id', ids),
      db.from('chat_members').select('conversation_id, member_name').in('conversation_id', ids),
    ]);
    if (cErr) { console.error('[Chat] conversations load failed', cErr); return; }

    const membersByConv = {};
    (allMem || []).forEach(m => { (membersByConv[m.conversation_id] || (membersByConv[m.conversation_id] = [])).push(m.member_name); });

    await loadReadState(ids);

    const enriched = await Promise.all((convs || []).map(async c => {
      const displayName = c.type === 'group'
        ? (c.title || 'Group')
        : ((membersByConv[c.id] || []).filter(n => n !== me.name)[0] || c.dm_key || 'Direct message');

      // select('*') so this degrades gracefully before the 4a migration runs —
      // attachment_* are simply absent until then (no "column does not exist").
      const { data: last } = await db.from('chat_messages')
        .select('*')
        .eq('conversation_id', c.id).order('created_at', { ascending: false }).limit(1);
      const lastMsg = last && last[0] ? last[0] : null;

      let unread = 0;
      const lr = lastReadAt[c.id];
      if (readAvailable && lr) {
        const { count } = await db.from('chat_messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', c.id).gt('created_at', lr).neq('sender_name', me.name);
        unread = count || 0;
      }
      return { ...c, displayName, lastMsg, lastAt: lastMsg ? lastMsg.created_at : c.created_at, unread };
    }));

    enriched.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    myConversations = enriched;
    convById = {}; unreadByConv = {};
    enriched.forEach(c => { convById[c.id] = c; unreadByConv[c.id] = c.unread; });

    renderInboxIfVisible();
    updateChatUnreadBadge();
  }

  // ── thread ──
  // Inner content of a message bubble — branches on attachment_kind so 4b (file)
  // and 4c (voice) are thin additions to this one function.
  function bubbleInner(m) {
    const caption = (m.message && m.message.trim())
      ? `<div class="chat-msg-bubble">${esc(m.message)}</div>` : '';
    if (m.attachment_kind === 'photo') {
      const url = signedUrlCache[m.attachment_path];
      const img = url
        ? `<a class="chat-att-photo-wrap" href="${esc(url)}" target="_blank" rel="noopener"><img class="chat-att-photo" src="${esc(url)}" alt="photo"></a>`
        : `<div class="chat-att-photo-loading">Loading photo…</div>`;
      return img + caption;
    }
    if (m.attachment_kind === 'file') {   // 4b seam — becomes a download chip
      return `<div class="chat-msg-bubble chat-att-file">📎 ${esc(m.attachment_name || 'File')}</div>` + caption;
    }
    if (m.attachment_kind === 'voice') {  // 4c seam — becomes an audio player
      return `<div class="chat-msg-bubble chat-att-voice">🎤 Voice message</div>` + caption;
    }
    return `<div class="chat-msg-bubble">${esc(m.message)}</div>`;
  }

  function renderThread() {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const me = getIdentity();
    box.innerHTML = threadMessages.map(m => `
      <div class="chat-msg ${m.sender_name === me.name ? 'me' : 'them'}">
        <div class="chat-msg-sender">${esc(m.sender_name)}</div>
        ${bubbleInner(m)}
        <div class="chat-msg-time">${formatChatTime(m.created_at)}</div>
      </div>`).join('');
    box.scrollTop = box.scrollHeight;
  }

  // Sign any not-yet-cached attachment paths (private bucket → signed URL at
  // render time, never stored). Best-effort; a failed sign leaves a placeholder.
  async function ensureSignedUrls(messages) {
    const paths = [...new Set((messages || [])
      .filter(m => m.attachment_path && !signedUrlCache[m.attachment_path])
      .map(m => m.attachment_path))];
    if (!paths.length) return;
    await Promise.all(paths.map(async (p) => {
      try {
        const { data } = await db.storage.from(ATTACH_BUCKET).createSignedUrl(p, 3600);
        if (data && data.signedUrl) signedUrlCache[p] = data.signedUrl;
      } catch (e) { console.warn('[Chat] sign url failed', e); }
    }));
  }

  async function loadThread(convId) {
    const { data, error } = await db.from('chat_messages')
      .select('*').eq('conversation_id', convId).order('created_at');
    if (error) { console.error('[Chat] thread load failed', error); threadMessages = []; }
    else threadMessages = data || [];
    await ensureSignedUrls(threadMessages);
    renderThread();
  }

  // fallbackTitle labels the back-bar when the conversation isn't in convById
  // yet (e.g. a DM/group just created in the compose flow, before loadInbox).
  async function openThread(convId, fallbackTitle) {
    currentConvId = convId;
    compose = null;
    const conv = convById[convId];
    setChrome('thread', conv ? conv.displayName : (fallbackTitle || ''), backToInbox);
    await loadThread(convId);
    markConversationRead(convId);
    const input = document.getElementById('chat-input');
    if (input) input.focus();
  }

  function backToInbox() {
    currentConvId = null;
    compose = null;
    setChrome('inbox');
    renderInbox();   // immediate paint from cached state
    loadInbox();     // then refresh previews / unread
  }

  // ── compose: new DM / new group (Slice 3c) ──────────────────
  async function loadRoster() {
    const me = getIdentity();
    const { data, error } = await db.from('employees')
      .select('name, role').eq('active', true).in('role', OFFICE_ROLES).order('name');
    if (error) { console.error('[Chat] roster load failed', error); compose.roster = []; return; }
    // Exclude the current user from every picker.
    compose.roster = (data || []).filter(p => p.name && p.name !== me.name);
  }

  async function openCompose() {
    const me = getIdentity();
    if (!me.name || !me.role) {
      alert('Could not identify you on this board yet — try reopening it from CrisData.');
      return;
    }
    compose = { step: 'chooser', groupName: '', roster: [] };
    await loadRoster();
    if (!compose) return;             // guard: backed out while roster loaded
    goComposeStep('chooser');
  }

  function goComposeStep(step) { if (compose) { compose.step = step; renderCompose(); } }

  function rosterRowsHtml(multi) {
    return compose.roster.map((p, i) => {
      const initial = (p.name || '?').trim().charAt(0).toUpperCase();
      const inner =
        `<span class="chat-roster-l">` +
          `<span class="chat-inbox-avatar">${esc(initial)}</span>` +
          `<span class="chat-roster-main">` +
            `<span class="chat-roster-name">${esc(p.name)}</span>` +
            `<span class="chat-roster-role">${esc(p.role)}</span>` +
          `</span>` +
        `</span>`;
      return multi
        ? `<label class="chat-roster-row">${inner}<input type="checkbox" data-idx="${i}"></label>`
        : `<button class="chat-roster-row" type="button" data-idx="${i}">${inner}</button>`;
    }).join('');
  }

  function renderCompose() {
    const box = document.getElementById('chat-messages');
    if (!box || !compose) return;
    const step = compose.step;
    const titles = { chooser: 'New message', dm: 'New chat', 'group-name': 'New group', 'group-members': 'New group' };
    const backs = {
      chooser: backToInbox,
      dm: () => goComposeStep('chooser'),
      'group-name': () => goComposeStep('chooser'),
      'group-members': () => goComposeStep('group-name'),
    };
    setChrome('compose', titles[step], backs[step]);

    if (step === 'chooser') {
      box.innerHTML =
        `<div class="chat-compose">` +
          `<button class="chat-compose-choice" type="button" data-path="dm">` +
            `<span class="chat-compose-ic">💬</span><span><b>New chat</b><small>Message one person</small></span>` +
          `</button>` +
          `<button class="chat-compose-choice" type="button" data-path="group">` +
            `<span class="chat-compose-ic">👥</span><span><b>New group</b><small>3–4 people</small></span>` +
          `</button>` +
        `</div>`;
      box.querySelectorAll('.chat-compose-choice').forEach(b =>
        b.addEventListener('click', () => goComposeStep(b.dataset.path === 'dm' ? 'dm' : 'group-name')));

    } else if (step === 'dm') {
      if (!compose.roster.length) { box.innerHTML = `<div class="chat-inbox-empty">No one else in the office to message.</div>`; return; }
      box.innerHTML =
        `<div class="chat-compose"><div class="chat-compose-hint">Choose someone to message</div>` +
        `<div class="chat-roster">${rosterRowsHtml(false)}</div></div>`;
      box.querySelectorAll('.chat-roster-row[data-idx]').forEach(b =>
        b.addEventListener('click', () => openOrCreateDm(compose.roster[+b.dataset.idx])));

    } else if (step === 'group-name') {
      box.innerHTML =
        `<div class="chat-compose">` +
          `<div class="chat-compose-hint">Group name</div>` +
          `<input class="chat-group-name" maxlength="40" placeholder="e.g. Front Office" value="${esc(compose.groupName)}">` +
          `<div class="chat-compose-err"></div>` +
          `<button class="chat-compose-next" type="button">Next</button>` +
        `</div>`;
      const input = box.querySelector('.chat-group-name');
      const err = box.querySelector('.chat-compose-err');
      const go = () => {
        const v = (input.value || '').trim();
        if (!v) { err.textContent = 'Enter a group name.'; return; }
        compose.groupName = v;
        goComposeStep('group-members');
      };
      box.querySelector('.chat-compose-next').addEventListener('click', go);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      input.focus();

    } else if (step === 'group-members') {
      if (compose.roster.length < 2) { box.innerHTML = `<div class="chat-inbox-empty">Not enough people in the office for a group.</div>`; return; }
      box.innerHTML =
        `<div class="chat-compose">` +
          `<div class="chat-compose-hint">Add members — pick at least 2 (a group is 3–4 people)</div>` +
          `<div class="chat-roster">${rosterRowsHtml(true)}</div>` +
          `<div class="chat-compose-err" id="chat-grp-err"></div>` +
          `<button class="chat-compose-create" type="button">Create group</button>` +
        `</div>`;
      const err = box.querySelector('#chat-grp-err');
      box.querySelector('.chat-compose-create').addEventListener('click', () => {
        const picked = [...box.querySelectorAll('input[type=checkbox]:checked')].map(c => compose.roster[+c.dataset.idx]);
        // A group needs at least 3 TOTAL (creator + 2). 1 other = a DM.
        if (picked.length < 2) { err.textContent = 'Pick at least 2 people — for one person use New chat.'; return; }
        if (picked.length + 1 > 4) { err.textContent = 'A group can have at most 4 people.'; return; }
        if (!compose.groupName) { err.textContent = 'Group name missing — go back a step.'; return; }
        createGroup(compose.groupName, picked);
      });
    }
    box.scrollTop = 0;
  }

  // DM: find-or-create by dm_key (two member names, lowercased, sorted, '|' —
  // the EXACT recipe the 3a migration used), so this never duplicates a DM.
  async function openOrCreateDm(person) {
    if (!person) return;
    const me = getIdentity();
    if (!me.name || !me.role) { alert('Could not identify you on this board yet — try reopening it from CrisData.'); return; }
    const key = [me.name.toLowerCase(), person.name.toLowerCase()].sort().join('|');

    const { data: found } = await db.from('chat_conversations')
      .select('id').eq('type', 'dm').eq('dm_key', key).limit(1);
    if (found && found[0]) { openThread(found[0].id, person.name); loadInbox(); return; }

    const { data: conv, error } = await db.from('chat_conversations')
      .insert({ type: 'dm', dm_key: key, created_by_name: me.name, created_by_role: me.role })
      .select('id').single();
    if (error) {
      // Race: another client created the same DM (unique dm_key) — re-find it.
      const { data: again } = await db.from('chat_conversations')
        .select('id').eq('type', 'dm').eq('dm_key', key).limit(1);
      if (again && again[0]) { openThread(again[0].id, person.name); loadInbox(); return; }
      console.error('[Chat] create DM failed', error);
      alert('Could not start chat: ' + error.message);
      return;
    }
    const { error: mErr } = await db.from('chat_members').insert([
      { conversation_id: conv.id, member_name: me.name, member_role: me.role },
      { conversation_id: conv.id, member_name: person.name, member_role: person.role },
    ]);
    if (mErr) console.warn('[Chat] add DM members failed', mErr.message);
    openThread(conv.id, person.name);
    loadInbox();
  }

  // Groups are NOT deduped (unlike DMs): two groups may share a name/members.
  async function createGroup(name, members) {
    const me = getIdentity();
    if (!me.name || !me.role) { alert('Could not identify you on this board yet — try reopening it from CrisData.'); return; }
    const { data: conv, error } = await db.from('chat_conversations')
      .insert({ type: 'group', title: name, dm_key: null, created_by_name: me.name, created_by_role: me.role })
      .select('id').single();
    if (error) {
      console.error('[Chat] create group failed', error);
      const el = document.getElementById('chat-grp-err');
      if (el) el.textContent = 'Could not create group: ' + error.message;
      return;
    }
    const rows = [{ conversation_id: conv.id, member_name: me.name, member_role: me.role }]
      .concat(members.map(p => ({ conversation_id: conv.id, member_name: p.name, member_role: p.role })));
    const { error: mErr } = await db.from('chat_members').insert(rows);
    if (mErr) console.warn('[Chat] add group members failed', mErr.message);
    openThread(conv.id, name);
    loadInbox();
  }

  // ── read-state ──
  async function markConversationRead(convId) {
    if (!convId) return;
    if (unreadByConv[convId]) {
      unreadByConv[convId] = 0;
      if (convById[convId]) convById[convId].unread = 0;
      updateChatUnreadBadge();
      renderInboxIfVisible();
    }
    const me = getIdentity();
    if (!readAvailable || !me.name) return;
    const nowIso = new Date().toISOString();
    lastReadAt[convId] = nowIso;
    const { error } = await db.from('chat_reads').upsert(
      { conversation_id: convId, reader_role: me.role || null, reader_name: me.name, last_read_at: nowIso },
      { onConflict: 'conversation_id,reader_name' }
    );
    if (error) {
      if (isMissingTable(error)) readAvailable = false;
      else console.warn('[Chat] read upsert failed', error.message);
    }
  }

  // ── send ──
  async function sendChatMsg() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !currentConvId) return;   // only send from an open thread
    const id = getIdentity();
    if (!id.name || !id.role) {
      alert('Could not identify you on this board yet — try reopening it from CrisData.');
      return;
    }
    input.value = '';
    // New rows carry conversation_id and leave channel null (old rows keep
    // their channel for audit — see 20260720_chat_conversations.sql).
    const { error } = await db.from('chat_messages').insert({
      conversation_id: currentConvId,
      sender_role: id.role,
      sender_name: id.name,
      message: text,
    });
    if (error) {
      console.error('[Chat] send failed', error);
      alert('Message failed to send: ' + error.message);
      input.value = text;   // don't lose the text
      return;
    }
    firePush(id, text, null);
  }

  // Best-effort closed-phone push. Fire-and-forget + fully guarded: the message
  // already saved, so a missing/!ok/failed push must NEVER surface to the sender
  // or block sending. The endpoint (api/send-push.js) resolves recipients from
  // conversationId via chat_members; attachment info lets it label an
  // attachment-only push ("📷 Photo") instead of an empty body.
  function firePush(id, previewText, attachment) {
    const body = {
      conversationId: currentConvId,
      senderName: id.name,
      senderRole: id.role,
      messagePreview: previewText || '',
    };
    if (attachment) {
      body.attachmentKind = attachment.kind;
      body.attachmentName = attachment.name || null;
    }
    try {
      fetch('/api/send-push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cd-push-secret': 'YQ87V5nheXAcwx7tMI6w50LjRxOSB9NuVLFqyrF5_sc',
        },
        body: JSON.stringify(body),
      }).catch(function (e) { console.warn('[Chat] push notify failed (ignored)', e); });
    } catch (e) { /* swallow — never affects the send */ }
  }

  // ── attachments (Slice 4a: photo; 4b file / 4c voice reuse this path) ──
  // Upload FIRST, insert the message row ONLY on a successful upload, so a
  // failed upload never leaves a broken/pointer-less message row.
  async function uploadAndSendPhoto(file) {
    if (!file || !currentConvId) return;
    const id = getIdentity();
    if (!id.name || !id.role) {
      alert('Could not identify you on this board yet — try reopening it from CrisData.');
      return;
    }
    if (!file.type || file.type.indexOf('image/') !== 0) { alert('Please pick an image.'); return; }
    if (file.size > ATTACH_MAX_BYTES) { alert('That image is too large (max 10MB).'); return; }

    const input = document.getElementById('chat-input');
    const caption = input ? input.value.trim() : '';

    setAttachBusy(true);
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `chat/${currentConvId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await db.storage.from(ATTACH_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (upErr) throw upErr;

      const { error: insErr } = await db.from('chat_messages').insert({
        conversation_id: currentConvId,
        sender_role: id.role,
        sender_name: id.name,
        message: caption || null,          // optional caption, or a standalone photo
        attachment_path: path,
        attachment_kind: 'photo',
        attachment_name: file.name || null,
        attachment_mime: file.type || null,
      });
      if (insErr) throw insErr;

      if (input) input.value = '';         // caption consumed
      firePush(id, caption, { kind: 'photo', name: file.name || null });
    } catch (err) {
      console.error('[Chat] photo send failed', err);
      const hint = /bucket|not found|does not exist/i.test(err && err.message || '') ? ' (has the migration/bucket been set up?)' : '';
      alert('Photo failed to send: ' + ((err && err.message) || 'unknown error') + hint);
    } finally {
      setAttachBusy(false);
    }
  }

  function setAttachBusy(busy) {
    const btn = document.getElementById('chat-attach');
    if (btn) { btn.disabled = busy; btn.textContent = busy ? '⏳' : '📎'; }
  }

  // ── realtime ──
  function bumpConversation(rec, incrementUnread) {
    const c = convById[rec.conversation_id];
    if (!c) return;
    c.lastMsg = {
      message: rec.message, sender_name: rec.sender_name, created_at: rec.created_at,
      attachment_kind: rec.attachment_kind, attachment_name: rec.attachment_name,
    };
    c.lastAt = rec.created_at;
    if (incrementUnread) { c.unread = (c.unread || 0) + 1; unreadByConv[c.id] = c.unread; }
    myConversations.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    renderInboxIfVisible();
    updateChatUnreadBadge();
  }

  function maybeAlert(rec) {
    const me = getIdentity();
    if (!me.name || !me.role) return;          // pre-login: identity not resolved
    if (rec.sender_name === me.name) return;   // self-sent
    playChatAlertSound();                       // sound always plays
    const openVisible = isSurfaceVisible() && rec.conversation_id === currentConvId;
    if (openVisible) return;                    // already looking right at it
    showChatToast(rec);
  }

  function handleIncoming(rec) {
    if (!rec || !rec.conversation_id) return;
    // Unknown conversation — could be one I was just added to. Refresh
    // membership; if I'm a member it will appear (and future messages alert).
    if (!convById[rec.conversation_id]) { loadInbox(); return; }

    const me = getIdentity();
    const isSelf = rec.sender_name === me.name;
    const openVisible = isSurfaceVisible() && rec.conversation_id === currentConvId;

    if (rec.conversation_id === currentConvId) {
      threadMessages.push(rec);
      renderThread();   // paints immediately (a photo shows "Loading…" first)
      // Attachment rows arrive with attachment_* on the same row (no 2nd fetch);
      // sign the URL, then repaint so the image resolves.
      if (rec.attachment_path && !signedUrlCache[rec.attachment_path]) {
        ensureSignedUrls([rec]).then(renderThread);
      }
      if (openVisible) markConversationRead(currentConvId);
    }
    bumpConversation(rec, !isSelf && !openVisible);
    maybeAlert(rec);
  }

  function subscribeRealtime() {
    if (chatRealtimeChannel) { db.removeChannel(chatRealtimeChannel); chatRealtimeChannel = null; }
    chatRealtimeChannel = db.channel('chat-live')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        ({ new: rec }) => handleIncoming(rec))
      // On every (re)connect, refetch membership + inbox (and reload the open
      // thread) so a dropped socket never leaves stale state — the lesson from
      // the earlier realtime work.
      .subscribe((status) => { if (status === 'SUBSCRIBED') refreshAll(); });
  }

  function refreshAll() {
    loadInbox();
    if (currentConvId) loadThread(currentConvId);
  }

  // ── emoji picker (desktop convenience; phone keyboards have their own) ──
  const EMOJI_LIST = ['👍','👎','✅','❌','🔥','💯','👏','🙌','💪','🙏',
                       '😊','😂','😅','😉','😎','🤔','😬','😢','😡','🥳',
                       '🚗','🔧','⚙️','⚠️','🛠️','🔩','⏰','📞','📸','💰'];
  function renderEmojiPopover() {
    const pop = document.getElementById('emoji-popover');
    if (!pop) return;
    pop.innerHTML = EMOJI_LIST.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
    pop.querySelectorAll('[data-emoji]').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        input.value += btn.dataset.emoji;
        pop.style.display = 'none';
        input.focus();
      });
    });
  }
  const emojiBtn = document.getElementById('emoji-btn');
  if (emojiBtn) {
    emojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = document.getElementById('emoji-popover');
      pop.style.display = pop.style.display === 'none' ? 'grid' : 'none';
    });
  }
  document.addEventListener('click', (e) => {
    const pop = document.getElementById('emoji-popover');
    const btn = document.getElementById('emoji-btn');
    if (pop && pop.style.display !== 'none' && !pop.contains(e.target) && e.target !== btn) {
      pop.style.display = 'none';
    }
  });

  // ── input wiring ──
  const sendBtn = document.getElementById('chat-send');
  if (sendBtn) sendBtn.addEventListener('click', sendChatMsg);
  const inputEl = document.getElementById('chat-input');
  if (inputEl) inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMsg(); });

  // Attach control (Slice 4a) — injected into the composer so no board markup
  // changes. 4a wires the PHOTO picker directly; 4b/4c will turn this into a
  // small menu (photo / file / voice) reusing uploadAndSendPhoto's pattern.
  (function mountAttachControl() {
    const row = inputEl ? inputEl.closest('.chat-input-row') : document.querySelector('.chat-input-row');
    if (!row || document.getElementById('chat-attach')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'chat-attach';
    btn.className = 'chat-attach-btn';
    btn.title = 'Attach photo';
    btn.textContent = '📎';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'chat-file-input';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    btn.addEventListener('click', () => { if (!btn.disabled) fileInput.click(); });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';                 // allow re-picking the same file
      if (file) uploadAndSendPhoto(file);
    });
    row.insertBefore(btn, row.firstChild);   // leftmost in the composer
    row.appendChild(fileInput);
  })();

  // ── initial mount ──
  const panelEl = document.getElementById('chat-panel');
  if (panelEl) panelEl.classList.add(config.mode === 'panel' ? 'chat-mode-panel' : 'chat-mode-tab');
  setChrome('inbox');
  renderInbox();          // paints "Loading…" until membership resolves
  subscribeRealtime();    // SUBSCRIBED → refreshAll() loads the inbox
  renderEmojiPopover();

  // Identity resolves asynchronously (captureSessionAndGreet). Poll briefly,
  // then load the inbox once the name is known.
  (function hydrateWhenIdentityReady() {
    if (getIdentity().name) { loadInbox(); return; }
    let tries = 0;
    const iv = setInterval(() => {
      if (getIdentity().name) { clearInterval(iv); loadInbox(); }
      else if (++tries >= 25) clearInterval(iv);   // ~10s
    }, 400);
  })();

  // Reconcile on refocus — catches reads/messages from another device.
  window.addEventListener('focus', refreshAll);

  // Board wires these to its own surface (sidebar tab / floating panel).
  return {
    refetch: refreshAll,
    resubscribe: subscribeRealtime,
    getChannel: () => chatRealtimeChannel,
    // Call when the chat surface becomes visible: unlock audio, refresh the
    // inbox, and if a thread is open mark it read + reload + scroll.
    onSurfaceShown: () => {
      unlockChatAudio();
      loadInbox();
      if (currentConvId) {
        markConversationRead(currentConvId);
        loadThread(currentConvId);
        const box = document.getElementById('chat-messages');
        if (box) box.scrollTop = box.scrollHeight;
      }
    },
  };
}
