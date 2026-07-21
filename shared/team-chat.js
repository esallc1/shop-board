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
  let currentConvMembers = [];      // [{member_name, member_role}] of the open thread (info sub-slice 1)
  let currentConvIsGroup = false;   // is the open thread a group (drives header member line + info)
  let currentConvTitle = '';        // display title of the open thread (bold header line)
  let currentConvPhotoPath = null;  // open group's photo_path (avatars sub-slice 2); null = 👥 glyph
  let groupPhotoInput = null;       // lazily-created hidden <input type=file> for the group photo picker
  let personAvatarByName = {};      // name -> employees.avatar_path (avatars sub-slice 3); shared across chat rendering
  let myAvatarPath = null;          // current user's own avatar_path (the "me" entry point)
  let personPhotoInput = null;      // lazily-created hidden <input type=file> for the self photo picker
  let infoOpen = false;             // conversation-info screen is showing over #chat-messages
  let chatRealtimeChannel = null;
  let chatAudioCtx = null;
  let compose = null;               // compose-flow state (Slice 3c): {step, groupName, roster}
  const signedUrlCache = {};        // attachment_path -> signed URL (Slice 4a)

  const ATTACH_BUCKET = 'crisdata-attachments';       // private; read via createSignedUrl
  const MSG_DELETED_TEXT = 'This message was deleted';   // tombstone label (delete slice)
  const ATTACH_MAX_PHOTO_BYTES = 10 * 1024 * 1024;    // ~10MB per photo
  const ATTACH_MAX_FILE_BYTES = 25 * 1024 * 1024;     // ~25MB per file (any type)
  const VOICE_MAX_SECONDS = 120;                      // 2-min per-clip cap (auto-stops)
  let voice = null;                                   // voice-recorder state (Slice 4c)

  // The office roster the compose pickers draw from. These are role STRINGS as
  // stored in employees.role (note the bookkeeper's role is 'bookkeeping', not
  // 'bookkeeper'); person NAMES are always resolved live from employees, never
  // hardcoded. Techs are never in this set, so they never appear in a picker.
  const OFFICE_ROLES = ['owner', 'manager', 'advisor', 'bookkeeping'];

  // ── durable read-state (chat_reads) — with defensive in-memory fallback ──
  let readAvailable = true;         // flips false if chat_reads ever looks unmigrated
  const lastReadAt = {};            // conversation_id -> ISO last_read_at (MY reads; unread counts)
  // Read receipts (seen): OTHER members' last_read_at for the OPEN thread only.
  // name -> ISO last_read_at. Rebuilt per thread open; advanced by realtime.
  let readsByMember = {};

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
    if (msg.deleted_at) return MSG_DELETED_TEXT;   // tombstone
    const caption = (msg.message || '').trim();
    if (caption) return caption;
    if (msg.attachment_kind) return attachmentLabel(msg.attachment_kind, msg.attachment_name);
    return msg.message || '';
  }

  // Voice-recorder mime helpers (Slice 4c) — lifted from the tech Diagnosis
  // recorder (my-numbers.html) so iOS + Android capture behaves identically.
  function pickAudioMime() {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/mpeg'];
    if (!window.MediaRecorder) return '';
    for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ } }
    return '';
  }
  function audioExt(mime) {
    mime = mime || '';
    if (mime.indexOf('webm') >= 0) return 'webm';
    if (mime.indexOf('mp4') >= 0) return 'm4a';
    if (mime.indexOf('aac') >= 0) return 'aac';
    if (mime.indexOf('mpeg') >= 0) return 'mp3';
    return 'webm';
  }
  function mmss(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
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
  // Local-midnight of a Date (device timezone) — the day boundary for thread
  // day-dividers. created_at is stored UTC; new Date() renders it in local time,
  // so getFullYear/Month/Date here reflect the user's calendar day.
  function localMidnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function localDayKey(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toDateString(); }
  // Day-divider label: Today / Yesterday / weekday (<7d) / full date (older).
  function daySeparatorLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const diffDays = Math.round((localMidnight(new Date()) - localMidnight(d)) / 86400000);
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // A column that doesn't exist yet — lets avatar features degrade to initials
  // before the sub-slice-3 migration runs (same spirit as isMissingTable).
  function isMissingColumn(err) {
    const code = (err && err.code) || '', msg = (err && err.message) || '';
    return code === '42703' || /column .* does not exist/i.test(msg);
  }

  // ── one-time CSS injection (keeps 3b styling identical across all boards,
  //    including owner-board which has its own inline chat CSS) ──
  (function injectChatCss() {
    if (document.getElementById('cd-teamchat-3b-css')) return;
    const css = `
.chat-panel.chat-view-inbox .chat-input-row,
.chat-panel.chat-view-compose .chat-input-row { display:none; }
.chat-panel.chat-view-inbox #chat-channels {
  /* The "me" avatar is centered in the full header width (WhatsApp profile
     style); the ✎ pencil is pinned absolutely to the right so it never pushes
     the avatar off-center. 8px vertical padding matches the other headers. */
  position:relative;
  display:flex; align-items:center; justify-content:center; padding:8px 10px;
}
.chat-panel.chat-view-inbox #chat-channels .chat-compose-btn {
  position:absolute; right:10px; top:50%; transform:translateY(-50%);
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
/* iOS focus-zoom fix: Safari auto-zooms the page when a text field with
   computed font-size < 16px gets focus, and doesn't zoom back out afterward.
   Force every focusable text field in the chat UI to >=16px. #chat-input beats
   the board's .chat-input-row input rule (0.82rem, board-shell.css + owner
   inline) by ID specificity; the .chat-compose input/textarea rule covers the
   New-group name and any future search/roster-filter field. Padding keeps the
   visual footprint compact — do NOT use maximum-scale/user-scalable (an a11y
   regression on iOS). Font-size is the fix. */
#chat-input,
.chat-compose input,
.chat-compose textarea { font-size:16px; }
/* Keep the send button always visible in the narrow composer (phone / owner FAB
   panel). After the 16px bump the input's default min-width:auto made it refuse
   to shrink, overflowing the one-line row and pushing #chat-send off the right
   edge. Let the input flex AND shrink (flex-basis 0 + min-width:0) so the three
   fixed controls (attach / emoji / send) always keep their space; row never wraps. */
#chat-input { flex:1 1 0%; min-width:0; }
.chat-input-row { flex-wrap:nowrap; }
.chat-input-row .chat-send-btn,
.chat-input-row .emoji-btn,
.chat-input-row .chat-attach-wrap { flex-shrink:0; }
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
/* thread day-divider (display-only, WhatsApp-style centered muted pill) */
.chat-day-sep { display:flex; justify-content:center; margin:2px 0; }
.chat-day-sep span {
  font-size:0.68rem; font-weight:600; color:var(--muted); letter-spacing:0.02em;
  background:#eef0f5; border:1px solid var(--border); padding:3px 10px; border-radius:12px;
}
/* read receipt on my OWN sent bubbles (next to the timestamp): sent = grey ✓,
   seen = indigo ✓✓. Always on; no "delivered" state. */
.chat-receipt { margin-left:4px; font-weight:700; letter-spacing:-2px; color:var(--muted); }
.chat-receipt.is-seen { color:var(--accent); }
/* message delete (tombstone + own-message ⋯/long-press affordance + menu) */
.chat-msg { position:relative; }   /* anchor for the ⋯ affordance */
.chat-msg .chat-msg-bubble.chat-msg-deleted,
.chat-msg.me .chat-msg-bubble.chat-msg-deleted {
  background:#f0f1f5; color:var(--muted); border:1px solid var(--border);
  font-style:italic; font-size:0.8rem;
}
.chat-msg-menu-btn {
  position:absolute; top:-6px; right:-2px; width:22px; height:22px; border-radius:50%; padding:0;
  border:1px solid var(--border); background:#fff; color:var(--muted); cursor:pointer;
  font-size:0.9rem; line-height:1; box-shadow:0 1px 4px rgba(0,0,0,0.12);
  display:none; align-items:center; justify-content:center; z-index:2;
}
@media (hover:hover) { .chat-msg[data-own]:hover .chat-msg-menu-btn { display:flex; } }
.chat-msg-menu {
  position:fixed; z-index:9600; min-width:120px;
  background:#fff; border:1px solid var(--border); border-radius:10px;
  box-shadow:0 6px 20px rgba(0,0,0,0.18); padding:6px; display:flex; flex-direction:column; gap:2px;
}
.chat-msg-menu button {
  background:none; border:none; text-align:left; font-family:inherit; font-size:0.85rem; font-weight:600;
  padding:8px 12px; border-radius:8px; cursor:pointer; color:#dc2626;
}
.chat-msg-menu button:hover { background:#fdeaea; }
.chat-att-photo-loading {
  width:160px; height:110px; border-radius:12px; border:1px dashed var(--border);
  display:flex; align-items:center; justify-content:center;
  color:var(--muted); font-size:0.74rem; background:#fff;
}
.chat-att-file { font-weight:600; }
/* attach chooser menu (Slice 4b) */
.chat-attach-wrap { position:relative; flex:0 0 auto; display:flex; }
.chat-attach-menu {
  position:absolute; bottom:44px; left:0; z-index:12; min-width:150px;
  background:#fff; border:1px solid var(--border); border-radius:10px;
  box-shadow:0 6px 20px rgba(0,0,0,0.15); padding:6px; flex-direction:column; gap:2px;
}
.chat-attach-menu button {
  background:none; border:none; text-align:left; font-family:inherit; font-size:0.82rem;
  padding:8px 10px; border-radius:8px; cursor:pointer; color:var(--text);
}
.chat-attach-menu button:hover { background:#f4f6fb; }
/* file download chip (Slice 4b) */
.chat-att-file-chip {
  display:flex; align-items:center; gap:8px; max-width:240px; text-decoration:none;
  padding:9px 11px; background:#fff; border:1px solid var(--border); border-radius:12px; color:var(--text);
}
.chat-att-file-chip:hover { background:#f4f6fb; }
.chat-att-file-chip.is-loading { opacity:.7; }
.chat-att-file-ic { font-size:1.2rem; flex:0 0 auto; }
.chat-att-file-name { flex:1; min-width:0; font-size:0.82rem; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chat-att-file-dl { flex:0 0 auto; color:var(--muted); font-size:0.9rem; }
/* voice record panel + player (Slice 4c) */
.chat-voice-panel { display:none; align-items:center; flex-wrap:wrap; gap:8px; padding:10px 12px; border-top:1px solid var(--border); background:#fff; }
.chat-panel.chat-voicing .chat-voice-panel { display:flex; }
.chat-panel.chat-voicing .chat-input-row { display:none; }
.chat-voice-rec, .chat-voice-stop, .chat-voice-send, .chat-voice-redo, .chat-voice-x {
  border:1px solid var(--border); background:#f0f1f7; cursor:pointer; font-family:inherit;
  border-radius:20px; padding:8px 14px; font-size:0.82rem; font-weight:600; color:var(--text);
}
.chat-voice-rec { background:var(--accent); color:#fff; border-color:var(--accent); flex:1; }
.chat-voice-stop { background:#ef4444; color:#fff; border-color:#ef4444; flex:1; }
.chat-voice-send { background:var(--accent); color:#fff; border-color:var(--accent); }
.chat-voice-timer { flex:1; font-weight:700; color:#ef4444; font-size:0.85rem; }
.chat-voice-audio { flex:1; min-width:120px; height:36px; }
.chat-voice-err { flex:1 1 100%; color:#dc2626; font-size:0.8rem; }
.chat-att-voice-audio { width:240px; max-width:100%; height:40px; }
.chat-att-voice-loading { color:var(--muted); font-size:0.78rem; padding:6px 0; }
/* group thread header member line + conversation-info screen (Avatars/Settings sub-slice 1);
   group photo avatars (sub-slice 2) */
.chat-thread-head {
  flex:1; min-width:0; display:flex; flex-direction:row; align-items:center; gap:8px;
  border:none; background:transparent; cursor:pointer; font-family:inherit;
  text-align:left; padding:0; overflow:hidden;
}
.chat-thread-head-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; overflow:hidden; }
.chat-thread-head:hover .chat-thread-title { text-decoration:underline; }
.chat-thread-head .chat-thread-title { width:100%; }
.chat-thread-members {
  font-size:0.68rem; color:var(--muted); font-weight:500; line-height:1.2;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%;
}
.chat-thread-avatar {
  flex:0 0 auto; width:30px; height:30px; border-radius:50%; background:#6b7280; color:#fff;
  display:flex; align-items:center; justify-content:center; font-size:0.9rem;
}
/* group + person photo (circle, cover, no crop UI) — reused across inbox / header / info / me */
.chat-avatar-img { width:100%; height:100%; object-fit:cover; display:block; }
.chat-inbox-avatar.has-photo, .chat-thread-avatar.has-photo, .chat-info-avatar.has-photo,
.chat-me-avatar.has-photo, .chat-sender-avatar.has-photo {
  overflow:hidden; padding:0; background:#e5e7eb;
}
/* person avatars (sub-slice 3): initial circles default to the accent color,
   matching the existing .chat-inbox-avatar initial circles (groups are gray). */
.chat-thread-avatar.is-person, .chat-info-avatar.is-person { background:var(--accent); }
/* "me" entry point — the current user's own photo in the inbox header */
.chat-me-wrap { position:relative; display:flex; flex:0 0 auto; }
.chat-me-avatar-btn {
  position:relative; border:none; background:transparent; padding:0; cursor:pointer;
  width:30px; height:30px; border-radius:50%; flex:0 0 auto;
}
.chat-me-avatar-btn.is-busy { opacity:0.55; cursor:default; }
.chat-me-avatar {
  width:30px; height:30px; border-radius:50%; background:var(--accent); color:#fff;
  display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.8rem; flex:0 0 auto;
}
.chat-me-add {
  position:absolute; right:-3px; bottom:-3px; width:15px; height:15px; border-radius:50%;
  background:#16a34a; color:#fff; font-size:0.7rem; line-height:1; border:2px solid #fff;
  display:flex; align-items:center; justify-content:center;
}
.chat-me-menu {
  /* position:fixed + JS-set top/left (from the avatar's rect) so the dropdown
     floats ABOVE the inbox list and is never clipped by the header's or list's
     overflow (no transformed ancestor traps a fixed element). */
  position:fixed; z-index:9500; min-width:150px;
  background:#fff; border:1px solid var(--border); border-radius:10px;
  box-shadow:0 6px 20px rgba(0,0,0,0.15); padding:6px; flex-direction:column; gap:2px;
}
.chat-me-menu button {
  background:none; border:none; text-align:left; font-family:inherit; font-size:0.82rem;
  padding:8px 10px; border-radius:8px; cursor:pointer; color:var(--text);
}
.chat-me-menu button:hover { background:#f4f6fb; }
.chat-me-menu button[data-me="remove"] { color:#dc2626; }
.chat-panel.chat-view-info .chat-input-row { display:none; }
.chat-info { display:flex; flex-direction:column; margin:-12px; }
.chat-info-head {
  display:flex; flex-direction:column; align-items:center; gap:6px;
  padding:22px 16px 18px; border-bottom:1px solid var(--border); background:#fff;
}
.chat-info-avatar {
  width:64px; height:64px; border-radius:50%; background:#6b7280; color:#fff;
  display:flex; align-items:center; justify-content:center; font-size:1.8rem; flex:0 0 auto;
}
/* tappable group avatar on the info screen (any member can change the photo) */
.chat-info-avatar-btn {
  position:relative; border:none; background:transparent; padding:0; cursor:pointer;
  width:64px; height:64px; border-radius:50%; flex:0 0 auto;
}
.chat-info-avatar-btn.is-busy { opacity:0.55; cursor:default; }
.chat-info-avatar-edit {
  position:absolute; right:-2px; bottom:-2px; width:24px; height:24px; border-radius:50%;
  background:var(--accent); color:#fff; font-size:0.78rem; border:2px solid #fff;
  display:flex; align-items:center; justify-content:center;
}
.chat-info-remove-photo {
  border:none; background:transparent; color:#dc2626; font-family:inherit;
  font-size:0.78rem; font-weight:600; cursor:pointer; padding:2px 6px; margin-top:2px;
}
.chat-info-remove-photo:hover { text-decoration:underline; }
.chat-info-remove-photo:disabled { opacity:0.5; cursor:default; text-decoration:none; }
.chat-info-name { font-weight:700; font-size:1rem; color:var(--text); text-align:center; word-break:break-word; }
.chat-info-sub { font-size:0.74rem; color:var(--muted); }
.chat-info-section-label {
  font-size:0.7rem; font-weight:700; color:var(--muted); text-transform:uppercase;
  letter-spacing:0.04em; padding:12px 14px 6px;
}
.chat-info-members { display:flex; flex-direction:column; }
.chat-info-member {
  display:flex; align-items:center; gap:10px;
  padding:9px 14px; background:#fff; border-bottom:1px solid var(--border);
}
.chat-info-member-main { display:flex; flex-direction:column; min-width:0; }
.chat-info-member-name { font-weight:600; font-size:0.85rem; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chat-info-member-role { font-size:0.72rem; color:var(--muted); text-transform:capitalize; }
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
  function setChrome(mode, title, backFn, opts) {
    opts = opts || {};
    const panel = document.getElementById('chat-panel');
    if (panel) {
      panel.classList.toggle('chat-view-inbox', mode === 'inbox');
      panel.classList.toggle('chat-view-thread', mode === 'thread');
      panel.classList.toggle('chat-view-compose', mode === 'compose');
      panel.classList.toggle('chat-view-info', mode === 'info');
    }
    const nav = document.getElementById('chat-channels');
    if (!nav) return;
    if (mode === 'inbox') {
      // Left: the "me" avatar (self-photo entry point). Right: the new-message
      // pencil. If I have no photo yet, my initial circle carries a "+" badge so
      // it reads as "add your photo".
      const meName = getIdentity().name;
      nav.innerHTML =
        `<div class="chat-me-wrap">` +
          `<button class="chat-me-avatar-btn" type="button" aria-label="Your photo" title="Your photo">` +
            personAvatarHtml(meName, 'me') +
            (myAvatarPath ? '' : `<span class="chat-me-add" aria-hidden="true">+</span>`) +
          `</button>` +
          `<div class="chat-me-menu" style="display:none">` +
            `<button type="button" data-me="change">Change photo</button>` +
            `<button type="button" data-me="remove">Remove photo</button>` +
          `</div>` +
        `</div>` +
        `<button class="chat-compose-btn" type="button" aria-label="New message" title="New message">✎</button>`;
      const c = nav.querySelector('.chat-compose-btn');
      if (c) c.addEventListener('click', openCompose);
      wireMeAvatar(nav);
    } else if (opts.memberLine !== undefined) {
      // GROUP thread header: bold group name + a muted member line under it; the
      // whole header (not the back arrow) is a tap target that opens group info.
      nav.innerHTML =
        `<button class="chat-back-btn" type="button" aria-label="Back">‹</button>` +
        `<button class="chat-thread-head" type="button" aria-label="Group info" title="Group info">` +
          (opts.avatarHtml || '') +
          `<span class="chat-thread-head-text">` +
            `<span class="chat-thread-title">${esc(title || '')}</span>` +
            `<span class="chat-thread-members">${esc(opts.memberLine)}</span>` +
          `</span>` +
        `</button>`;
      const back = nav.querySelector('.chat-back-btn');
      if (back) back.addEventListener('click', backFn || backToInbox);
      const head = nav.querySelector('.chat-thread-head');
      if (head && opts.onTitleClick) head.addEventListener('click', opts.onTitleClick);
    } else if (opts.personName !== undefined) {
      // DM thread header: the other person's small avatar + name; the whole
      // header is a tap target that opens the (read-only) DM info screen.
      nav.innerHTML =
        `<button class="chat-back-btn" type="button" aria-label="Back">‹</button>` +
        `<button class="chat-thread-head" type="button" aria-label="Contact info" title="Contact info">` +
          (opts.avatarHtml || '') +
          `<span class="chat-thread-head-text">` +
            `<span class="chat-thread-title">${esc(title || '')}</span>` +
          `</span>` +
        `</button>`;
      const back = nav.querySelector('.chat-back-btn');
      if (back) back.addEventListener('click', backFn || backToInbox);
      const head = nav.querySelector('.chat-thread-head');
      if (head && opts.onTitleClick) head.addEventListener('click', opts.onTitleClick);
    } else {
      // Compose steps / info back-bar — single title line.
      nav.innerHTML =
        `<button class="chat-back-btn" type="button" aria-label="Back">‹</button>` +
        `<span class="chat-thread-title">${esc(title || '')}</span>`;
      const back = nav.querySelector('.chat-back-btn');
      if (back) back.addEventListener('click', backFn || backToInbox);
    }
  }

  // Wire the "me" avatar in the inbox header: no photo → tap opens the picker;
  // photo set → tap toggles a Change/Remove menu. Self-service only.
  function wireMeAvatar(nav) {
    const btn = nav.querySelector('.chat-me-avatar-btn');
    const menu = nav.querySelector('.chat-me-menu');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      if (!myAvatarPath) { pickPersonPhoto(); return; }
      if (menu.style.display === 'none') openMeMenu(btn, menu);
      else menu.style.display = 'none';
    });
    if (menu) {
      menu.querySelector('[data-me="change"]').addEventListener('click', () => { menu.style.display = 'none'; pickPersonPhoto(); });
      menu.querySelector('[data-me="remove"]').addEventListener('click', () => { menu.style.display = 'none'; removePersonPhoto(); });
      document.addEventListener('click', (e) => {
        if (menu.style.display !== 'none' && !nav.querySelector('.chat-me-wrap').contains(e.target)) menu.style.display = 'none';
      });
    }
  }

  // Open the "me" menu as a fixed overlay anchored under the avatar. Fixed coords
  // (from the button's viewport rect) let it float over the inbox list and stay
  // clear of the panel's right edge in the narrow owner FAB.
  function openMeMenu(btn, menu) {
    menu.style.display = 'flex';                 // display first so offsetWidth is measurable
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth || 150;
    const vw = window.innerWidth;
    let left = r.left;
    if (left + mw > vw - 8) left = vw - 8 - mw;  // keep off the right edge
    if (left < 8) left = 8;
    menu.style.left = left + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
  }

  // ── inbox ──
  // Repaint the inbox only when it's actually the visible screen — not while a
  // thread is open (currentConvId set) or the compose flow owns #chat-messages.
  function renderInboxIfVisible() { if (currentConvId === null && !compose) renderInbox(); }
  // Repaint just the inbox header bar (the "me" avatar + compose pencil) when the
  // inbox is the visible screen — used after person avatars load / a self-photo change.
  function refreshInboxHeaderIfVisible() { if (currentConvId === null && !compose && !infoOpen) setChrome('inbox'); }

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
        ? (c.lastMsg.deleted_at
            ? `<span class="chat-inbox-none">${esc(MSG_DELETED_TEXT)}</span>`
            : `${c.lastMsg.sender_name === me.name ? 'You' : esc(c.lastMsg.sender_name)}: ${esc(truncate(previewTextFor(c.lastMsg), 42))}`)
        : `<span class="chat-inbox-none">No messages yet</span>`;
      const time = c.lastMsg ? formatInboxTime(c.lastAt) : '';
      const badge = c.unread > 0 ? `<span class="chat-inbox-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
      const avatar = c.type === 'group'
        ? groupAvatarHtml(c.photo_path, 'inbox')
        : personAvatarHtml(c.displayName, 'inbox');   // DM row → other person's photo/initial
      return `<button class="chat-inbox-row" data-conv="${c.id}">
        ${avatar}
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

    // Person avatars (name -> avatar_path) power the "me" entry point + every DM
    // row / header / info avatar. Load them up front so the first paint has photos.
    await loadPersonAvatars();
    refreshInboxHeaderIfVisible();   // reflect the loaded "me" photo on the pencil bar

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

    // Sign group avatars up front so the first inbox paint shows the photo (not
    // the glyph then a flash to the photo). photo_path is simply undefined until
    // the 20260721_chat_group_photo migration runs → nothing to sign, no error.
    await ensureSignedForPaths(enriched.filter(c => c.type === 'group' && c.photo_path).map(c => c.photo_path));
    // Keep the open group's cached photo pointer in sync with a background reload.
    if (currentConvId && convById[currentConvId]) currentConvPhotoPath = convById[currentConvId].photo_path || null;

    renderInboxIfVisible();
    updateChatUnreadBadge();
  }

  // ── thread ──
  // Inner content of a message bubble — branches on attachment_kind so 4b (file)
  // and 4c (voice) are thin additions to this one function.
  function bubbleInner(m) {
    if (m.deleted_at) {   // tombstone — no attachment / caption / receipt, ordering kept
      return `<div class="chat-msg-bubble chat-msg-deleted">🚫 ${esc(MSG_DELETED_TEXT)}</div>`;
    }
    const caption = (m.message && m.message.trim())
      ? `<div class="chat-msg-bubble">${esc(m.message)}</div>` : '';
    if (m.attachment_kind === 'photo') {
      const url = signedUrlCache[m.attachment_path];
      const img = url
        ? `<a class="chat-att-photo-wrap" href="${esc(url)}" target="_blank" rel="noopener"><img class="chat-att-photo" src="${esc(url)}" alt="photo"></a>`
        : `<div class="chat-att-photo-loading">Loading photo…</div>`;
      return img + caption;
    }
    if (m.attachment_kind === 'file') {   // 4b — download chip (not an inline preview)
      const url = signedUrlCache[m.attachment_path];
      const nameEsc = esc(m.attachment_name || 'File');
      const chip = url
        ? `<a class="chat-att-file-chip" href="${esc(url)}" target="_blank" rel="noopener" download="${nameEsc}">` +
            `<span class="chat-att-file-ic">📄</span><span class="chat-att-file-name">${nameEsc}</span><span class="chat-att-file-dl">⬇</span></a>`
        : `<div class="chat-att-file-chip is-loading"><span class="chat-att-file-ic">📄</span><span class="chat-att-file-name">${nameEsc}</span></div>`;
      return chip + caption;
    }
    if (m.attachment_kind === 'voice') {  // 4c — inline audio player
      const url = signedUrlCache[m.attachment_path];
      // preload="none" — the "--:-- / spinner before first play" is normal iOS
      // behavior, not a bug (same as the Diagnosis recorder).
      const player = url
        ? `<audio class="chat-att-voice-audio" controls preload="none" src="${esc(url)}"></audio>`
        : `<div class="chat-att-voice-loading">🎤 Loading…</div>`;
      return player + caption;
    }
    return `<div class="chat-msg-bubble">${esc(m.message)}</div>`;
  }

  // ── read receipts ("seen") — derived entirely from chat_reads; my own
  //    outgoing messages only. States: 'sent' | 'seen' (no "delivered"). ──
  // A message is SEEN when EVERY other member's last_read_at >= its created_at
  // (DM = the one other member; group = all others, binary/all-seen). Returns
  // null for anything that shouldn't carry a receipt (incoming, unknown sender).
  function receiptFor(m) {
    const me = getIdentity();
    if (!me.name || !m || m.sender_name !== me.name) return null;   // mine only
    if (m.deleted_at) return null;                                  // no checkmark on a tombstone
    const others = currentConvMembers
      .map(x => x.member_name)
      .filter(n => n && n !== me.name);
    if (!others.length) return 'sent';   // unknown/solo membership → don't claim "seen"
    const msgT = new Date(m.created_at).getTime();
    const allSeen = others.every(n => {
      const lr = readsByMember[n];
      return lr && new Date(lr).getTime() >= msgT;
    });
    return allSeen ? 'seen' : 'sent';
  }
  function receiptHtml(m) {
    const st = receiptFor(m);
    if (!st) return '';
    return ` <span class="chat-receipt${st === 'seen' ? ' is-seen' : ''}" data-receipt="${esc(String(m.id))}">${st === 'seen' ? '✓✓' : '✓'}</span>`;
  }
  // TARGETED receipt refresh — flips existing icons in place (no renderThread,
  // so no scroll jump / flicker and the day dividers are untouched).
  function updateReceipts() {
    const me = getIdentity();
    if (!me.name) return;
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const stateById = {};
    threadMessages.forEach(m => {
      if (m.sender_name === me.name) { const st = receiptFor(m); if (st) stateById[String(m.id)] = st; }
    });
    box.querySelectorAll('.chat-receipt').forEach(el => {
      const st = stateById[el.getAttribute('data-receipt')];
      if (!st) return;
      el.textContent = st === 'seen' ? '✓✓' : '✓';
      el.classList.toggle('is-seen', st === 'seen');
    });
  }

  function renderThread() {
    if (infoOpen) return;   // info screen owns #chat-messages — don't repaint over it
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const me = getIdentity();
    // Walk oldest→newest; emit a centered day-divider (display-only, NOT a
    // message) whenever the local calendar day changes. This runs on every
    // renderThread, so the realtime append path (which pushes then re-renders)
    // gets a fresh divider above the first message of a new day automatically.
    let prevDayKey = null;
    box.innerHTML = threadMessages.map(m => {
      let sep = '';
      const dk = localDayKey(m.created_at);
      if (dk && dk !== prevDayKey) {
        prevDayKey = dk;
        sep = `<div class="chat-day-sep"><span>${esc(daySeparatorLabel(m.created_at))}</span></div>`;
      }
      const isOwn = m.sender_name === me.name;
      const canDelete = isOwn && !m.deleted_at;   // own-messages-only, not already tombstoned
      // data-mid on every row → targeted live tombstone; data-own gates the
      // long-press/⋯ delete affordance to my own live messages.
      return sep + `
      <div class="chat-msg ${isOwn ? 'me' : 'them'}"${canDelete ? ' data-own="1"' : ''} data-mid="${esc(String(m.id))}">
        ${canDelete ? `<button type="button" class="chat-msg-menu-btn" aria-label="Message actions" title="Delete message">⋯</button>` : ''}
        <div class="chat-msg-sender">${esc(m.sender_name)}</div>
        ${bubbleInner(m)}
        <div class="chat-msg-time">${formatChatTime(m.created_at)}${receiptHtml(m)}</div>
      </div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  // Sign any not-yet-cached storage paths (private bucket → signed URL at render
  // time, never stored). Best-effort; a failed sign leaves the glyph/placeholder.
  // Shared by message attachments (4a) and group avatars (Avatars sub-slice 2).
  async function ensureSignedForPaths(paths) {
    const need = [...new Set((paths || []).filter(p => p && !signedUrlCache[p]))];
    if (!need.length) return;
    await Promise.all(need.map(async (p) => {
      try {
        const { data } = await db.storage.from(ATTACH_BUCKET).createSignedUrl(p, 3600);
        if (data && data.signedUrl) signedUrlCache[p] = data.signedUrl;
      } catch (e) { console.warn('[Chat] sign url failed', e); }
    }));
  }
  function ensureSignedUrls(messages) {
    return ensureSignedForPaths((messages || []).filter(m => m.attachment_path).map(m => m.attachment_path));
  }

  // Group avatar HTML: a photo (signed URL, circle, object-fit cover) when
  // photo_path is set and signed, else the generic 👥 glyph. variant sizes it
  // for the inbox row / thread header / info screen.
  function groupAvatarHtml(photoPath, variant) {
    const base = variant === 'info' ? 'chat-info-avatar'
      : variant === 'header' ? 'chat-thread-avatar'
      : 'chat-inbox-avatar is-group';
    const url = photoPath ? signedUrlCache[photoPath] : null;
    if (url) return `<span class="${base} has-photo"><img class="chat-avatar-img" src="${esc(url)}" alt=""></span>`;
    return `<span class="${base}">👥</span>`;
  }

  // Person avatar HTML (sub-slice 3): the person's photo (signed URL, circle,
  // cover) when their employees.avatar_path is set + signed, else their existing
  // initial circle. variant sizes/colors it for each spot chat renders a person.
  function personAvatarHtml(name, variant) {
    const base = {
      inbox: 'chat-inbox-avatar',        // DM inbox row (other person)
      member: 'chat-inbox-avatar',       // group info member row
      header: 'chat-thread-avatar is-person',   // DM thread header
      info: 'chat-info-avatar is-person',       // DM info big avatar
      me: 'chat-me-avatar',              // "me" entry point in the inbox header
      sender: 'chat-sender-avatar',      // (reserved) group message sender avatar
    }[variant] || 'chat-inbox-avatar';
    const path = name ? personAvatarByName[name] : null;
    const url = path ? signedUrlCache[path] : null;
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    if (url) return `<span class="${base} has-photo"><img class="chat-avatar-img" src="${esc(url)}" alt=""></span>`;
    return `<span class="${base}">${esc(initial)}</span>`;
  }

  // Load the office roster's avatar_path map (name -> avatar_path) used across
  // chat rendering, and sign the photos. Techs are irrelevant to chat. Degrades
  // to plain initials before the 20260721_employee_avatar migration runs.
  async function loadPersonAvatars() {
    let { data, error } = await db.from('employees')
      .select('name, role, avatar_path').eq('active', true).in('role', OFFICE_ROLES);
    if (error) {
      if (isMissingColumn(error)) return;   // pre-migration: no avatars, keep initials
      console.warn('[Chat] person avatars load failed', error.message); return;
    }
    const map = {};
    (data || []).forEach(r => { if (r.name) map[r.name] = r.avatar_path || null; });
    personAvatarByName = map;
    const me = getIdentity();
    myAvatarPath = me.name ? (map[me.name] || null) : null;
    await ensureSignedForPaths(Object.values(map).filter(Boolean));
  }

  async function loadThread(convId) {
    const { data, error } = await db.from('chat_messages')
      .select('*').eq('conversation_id', convId).order('created_at');
    if (error) { console.error('[Chat] thread load failed', error); threadMessages = []; }
    else threadMessages = data || [];
    await loadReadsForConversation(convId);   // receipts: correct state BEFORE the first paint
    await ensureSignedUrls(threadMessages);
    renderThread();
  }

  // Load every member's last_read_at for the open conversation → readsByMember,
  // for the "seen" computation. Reset each load so state never leaks across
  // threads. Reuses the same anon-readable chat_reads table as unread counts.
  async function loadReadsForConversation(convId) {
    readsByMember = {};
    if (!readAvailable) return;
    const { data, error } = await db.from('chat_reads')
      .select('reader_name, last_read_at').eq('conversation_id', convId);
    if (error) {
      if (isMissingTable(error)) readAvailable = false;
      else console.warn('[Chat] reads load failed', error.message);
      return;
    }
    (data || []).forEach(r => { if (r.reader_name) readsByMember[r.reader_name] = r.last_read_at; });
  }

  // Load the open conversation's members (name + role) for the group header
  // member line and the info screen. Membership doesn't change this sub-slice,
  // so a per-open fetch is plenty (no realtime membership sync).
  async function loadConvMembers(convId) {
    const { data, error } = await db.from('chat_members')
      .select('member_name, member_role').eq('conversation_id', convId);
    if (error) { console.warn('[Chat] member load failed', error.message); currentConvMembers = []; return; }
    // Stable alphabetical order by name; the current user is included, no "You".
    currentConvMembers = (data || []).slice()
      .sort((a, b) => (a.member_name || '').localeCompare(b.member_name || ''));
  }

  // Paint the thread back-bar for the currently open conversation: a group gets
  // the two-line tappable header (bold title + member line → info); a DM keeps
  // the plain, non-tappable name header (unchanged behavior).
  function applyThreadChrome() {
    if (currentConvIsGroup) {
      const memberLine = currentConvMembers.map(m => m.member_name).filter(Boolean).join(', ');
      setChrome('thread', currentConvTitle, backToInbox, {
        memberLine, onTitleClick: openInfo,
        avatarHtml: groupAvatarHtml(currentConvPhotoPath, 'header'),
      });
    } else {
      // DM: the other person's avatar + name, tappable → read-only DM info.
      setChrome('thread', currentConvTitle, backToInbox, {
        personName: currentConvTitle, onTitleClick: openInfo,
        avatarHtml: personAvatarHtml(currentConvTitle, 'header'),
      });
    }
  }

  // fallbackTitle labels the back-bar when the conversation isn't in convById
  // yet (e.g. a DM/group just created in the compose flow, before loadInbox).
  async function openThread(convId, fallbackTitle) {
    if (voice) closeVoicePanel();   // cancel any in-progress recording on nav
    infoOpen = false;
    currentConvId = convId;
    compose = null;
    const conv = convById[convId];
    await loadConvMembers(convId);
    // conv.type is authoritative when known; for a just-created conversation not
    // yet in convById, a DM has exactly 2 members and a group has 3–4.
    currentConvIsGroup = conv ? conv.type === 'group' : currentConvMembers.length > 2;
    currentConvTitle = conv ? conv.displayName : (fallbackTitle || '');
    currentConvPhotoPath = conv ? (conv.photo_path || null) : null;
    applyThreadChrome();
    // Sign any not-yet-signed avatars in view (group photo + this conversation's
    // people), then repaint the header/info so they resolve in place.
    const pending = [currentConvPhotoPath]
      .concat(currentConvMembers.map(m => personAvatarByName[m.member_name]))
      .filter(p => p && !signedUrlCache[p]);
    if (pending.length) {
      ensureSignedForPaths(pending).then(() => {
        if (infoOpen) renderInfo(); else applyThreadChrome();
      });
    }
    await loadThread(convId);
    markConversationRead(convId);
    const input = document.getElementById('chat-input');
    if (input) input.focus();
  }

  function backToInbox() {
    if (voice) closeVoicePanel();   // cancel any in-progress recording on nav
    infoOpen = false;
    currentConvId = null;
    compose = null;
    setChrome('inbox');
    renderInbox();   // immediate paint from cached state
    loadInbox();     // then refresh previews / unread
  }

  // ── conversation info (read-only members; group photo editable) ────────────
  // Rendered over #chat-messages like compose; background loadInbox()/realtime
  // never repaint it (currentConvId stays set → inbox guard; infoOpen → thread
  // guard). Back returns to the THREAD, not the inbox. Groups (sub-slice 1/2)
  // AND DMs (sub-slice 3, other person's read-only profile) both open here.
  function openInfo() {
    if (!currentConvId) return;
    infoOpen = true;
    renderInfo();
  }

  function renderInfo() {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    if (currentConvIsGroup) renderGroupInfo(box);
    else renderDmInfo(box);
    box.scrollTop = 0;
  }

  function renderGroupInfo(box) {
    const conv = convById[currentConvId];
    const title = (conv ? conv.displayName : currentConvTitle) || 'Group';
    setChrome('info', title, backToThreadFromInfo);
    const rows = currentConvMembers.map(m =>
      `<div class="chat-info-member">` +
        personAvatarHtml(m.member_name, 'member') +   // sub-slice 3: each member's photo/initial
        `<span class="chat-info-member-main">` +
          `<span class="chat-info-member-name">${esc(m.member_name)}</span>` +
          `<span class="chat-info-member-role">${esc(m.member_role || '')}</span>` +
        `</span>` +
      `</div>`).join('');
    // The group avatar is tappable for ANY member → change the photo; a
    // "Remove photo" action shows only when a photo is set.
    box.innerHTML =
      `<div class="chat-info">` +
        `<div class="chat-info-head">` +
          `<button class="chat-info-avatar-btn" type="button" aria-label="Change group photo" title="Change group photo">` +
            groupAvatarHtml(currentConvPhotoPath, 'info') +
            `<span class="chat-info-avatar-edit" aria-hidden="true">✎</span>` +
          `</button>` +
          `<div class="chat-info-name">${esc(title)}</div>` +
          `<div class="chat-info-sub">${currentConvMembers.length} member${currentConvMembers.length === 1 ? '' : 's'}</div>` +
          (currentConvPhotoPath ? `<button class="chat-info-remove-photo" type="button">Remove photo</button>` : '') +
        `</div>` +
        `<div class="chat-info-section-label">Members</div>` +
        `<div class="chat-info-members">${rows}</div>` +
      `</div>`;
    const avBtn = box.querySelector('.chat-info-avatar-btn');
    if (avBtn) avBtn.addEventListener('click', pickGroupPhoto);
    const rmBtn = box.querySelector('.chat-info-remove-photo');
    if (rmBtn) rmBtn.addEventListener('click', removeGroupPhoto);
  }

  // DM info: the OTHER person's read-only profile (big avatar + name + role).
  // Self-service means you never edit their photo from here — no edit control.
  function renderDmInfo(box) {
    const me = getIdentity();
    const other = currentConvMembers.find(m => m.member_name !== me.name)
      || currentConvMembers[0] || null;
    const oname = (other ? other.member_name : currentConvTitle) || 'Direct message';
    const orole = other ? (other.member_role || '') : '';
    setChrome('info', oname, backToThreadFromInfo);
    box.innerHTML =
      `<div class="chat-info">` +
        `<div class="chat-info-head">` +
          personAvatarHtml(oname, 'info') +
          `<div class="chat-info-name">${esc(oname)}</div>` +
          (orole ? `<div class="chat-info-sub" style="text-transform:capitalize">${esc(orole)}</div>` : '') +
        `</div>` +
      `</div>`;
  }

  // ── group photo (Avatars sub-slice 2) — ANY member may set/change/remove.
  //    Reuses the crisdata-attachments bucket + the 4a picker constraints. ──
  function pickGroupPhoto() {
    if (!currentConvId || !currentConvIsGroup) return;
    if (!groupPhotoInput) {
      groupPhotoInput = document.createElement('input');
      groupPhotoInput.type = 'file';
      groupPhotoInput.accept = 'image/*';
      groupPhotoInput.style.display = 'none';
      groupPhotoInput.addEventListener('change', () => {
        const file = groupPhotoInput.files && groupPhotoInput.files[0];
        groupPhotoInput.value = '';                 // allow re-picking the same file
        if (file) uploadGroupPhoto(file);
      });
      document.body.appendChild(groupPhotoInput);
    }
    groupPhotoInput.click();
  }

  function setGroupPhotoBusy(busy) {
    const btn = document.querySelector('.chat-info-avatar-btn');
    if (btn) { btn.disabled = busy; btn.classList.toggle('is-busy', busy); }
    const rm = document.querySelector('.chat-info-remove-photo');
    if (rm) rm.disabled = busy;
  }

  // UPLOAD-FIRST-THEN-UPDATE: upload the image, and only on success point
  // chat_conversations.photo_path at it — a failed upload never leaves a
  // dangling pointer. Optimistic: the setter sees the new photo immediately.
  async function uploadGroupPhoto(file) {
    const convId = currentConvId;
    if (!convId || !currentConvIsGroup) return;
    const me = getIdentity();
    if (!me.name) { alert('Could not identify you on this board yet — try reopening it from CrisData.'); return; }
    if (!file.type || file.type.indexOf('image/') !== 0) { alert('Please pick an image.'); return; }
    if (file.size > ATTACH_MAX_PHOTO_BYTES) { alert('That image is too large (max 10MB).'); return; }

    setGroupPhotoBusy(true);
    try {
      // avatars/group/<conversationId>/<uuid> — namespaced apart from message
      // attachments (chat/<conversationId>/…). A new uuid each time avoids any
      // signed-URL cache collision when the photo is replaced.
      const path = `avatars/group/${convId}/${crypto.randomUUID()}`;
      const { error: upErr } = await db.storage.from(ATTACH_BUCKET)
        .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
      if (upErr) throw upErr;                        // upload failed → do NOT touch the row

      const { error: updErr } = await db.from('chat_conversations')
        .update({ photo_path: path }).eq('id', convId);
      if (updErr) throw updErr;

      await ensureSignedForPaths([path]);            // sign then reflect immediately
      applyGroupPhoto(convId, path);
    } catch (err) {
      console.error('[Chat] group photo failed', err);
      const hint = /bucket|not found|does not exist|column|photo_path/i.test(err && err.message || '')
        ? ' (has the migration/bucket been set up?)' : '';
      alert('Group photo failed: ' + ((err && err.message) || 'unknown error') + hint);
    } finally {
      setGroupPhotoBusy(false);
    }
  }

  async function removeGroupPhoto() {
    const convId = currentConvId;
    if (!convId || !currentConvPhotoPath) return;
    setGroupPhotoBusy(true);
    try {
      const { error } = await db.from('chat_conversations')
        .update({ photo_path: null }).eq('id', convId);
      if (error) throw error;
      // Leave the storage object (low-stakes, reversible feature); just clear
      // the pointer so it reverts to the 👥 glyph.
      applyGroupPhoto(convId, null);
    } catch (err) {
      console.error('[Chat] remove group photo failed', err);
      alert('Could not remove photo: ' + ((err && err.message) || 'unknown error'));
    } finally {
      setGroupPhotoBusy(false);
    }
  }

  // Reflect a photo change everywhere: update the inbox cache + the open-thread
  // pointer, then repaint whatever's on screen (info if open, else the header).
  function applyGroupPhoto(convId, path) {
    if (convById[convId]) convById[convId].photo_path = path;
    if (convId === currentConvId) currentConvPhotoPath = path;
    if (infoOpen) renderInfo();
    else if (currentConvId === convId && currentConvIsGroup) applyThreadChrome();
    else renderInboxIfVisible();
  }

  // ── person photo (Avatars sub-slice 3) — SELF-SERVICE: you only ever set /
  //    change / remove your OWN photo (the "me" entry point in the inbox header). ──
  function pickPersonPhoto() {
    const me = getIdentity();
    if (!me.name || !me.role) { alert('Could not identify you on this board yet — try reopening it from CrisData.'); return; }
    if (!personPhotoInput) {
      personPhotoInput = document.createElement('input');
      personPhotoInput.type = 'file';
      personPhotoInput.accept = 'image/*';
      personPhotoInput.style.display = 'none';
      personPhotoInput.addEventListener('change', () => {
        const file = personPhotoInput.files && personPhotoInput.files[0];
        personPhotoInput.value = '';                 // allow re-picking the same file
        if (file) uploadPersonPhoto(file);
      });
      document.body.appendChild(personPhotoInput);
    }
    personPhotoInput.click();
  }

  function setMeBusy(busy) {
    const btn = document.querySelector('.chat-me-avatar-btn');
    if (btn) { btn.disabled = busy; btn.classList.toggle('is-busy', busy); }
  }

  // UPLOAD-FIRST-THEN-UPDATE on the CURRENT USER'S own employees row (matched by
  // live getIdentity name + role — self-service, never anyone else's). A failed
  // upload never touches the row → no dangling pointer.
  async function uploadPersonPhoto(file) {
    const me = getIdentity();
    if (!me.name || !me.role) { alert('Could not identify you on this board yet — try reopening it from CrisData.'); return; }
    if (!file.type || file.type.indexOf('image/') !== 0) { alert('Please pick an image.'); return; }
    if (file.size > ATTACH_MAX_PHOTO_BYTES) { alert('That image is too large (max 10MB).'); return; }

    setMeBusy(true);
    try {
      const slug = (me.name || 'me').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'me';
      // avatars/person/<name-slug>/<uuid> — namespaced apart from avatars/group/
      // and message chat/. New uuid each time avoids signed-URL cache collisions.
      const path = `avatars/person/${slug}/${crypto.randomUUID()}`;
      const { error: upErr } = await db.storage.from(ATTACH_BUCKET)
        .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
      if (upErr) throw upErr;                        // upload failed → do NOT touch the row

      const { error: updErr } = await db.from('employees')
        .update({ avatar_path: path }).eq('name', me.name).eq('role', me.role);
      if (updErr) throw updErr;

      await ensureSignedForPaths([path]);            // sign then reflect immediately
      applyPersonPhoto(me.name, path);
    } catch (err) {
      console.error('[Chat] person photo failed', err);
      const hint = /bucket|not found|does not exist|column|avatar_path/i.test(err && err.message || '')
        ? ' (has the migration/bucket been set up?)' : '';
      alert('Photo failed: ' + ((err && err.message) || 'unknown error') + hint);
    } finally {
      setMeBusy(false);
    }
  }

  async function removePersonPhoto() {
    const me = getIdentity();
    if (!me.name || !me.role) return;
    setMeBusy(true);
    try {
      const { error } = await db.from('employees')
        .update({ avatar_path: null }).eq('name', me.name).eq('role', me.role);
      if (error) throw error;
      applyPersonPhoto(me.name, null);   // leave the storage object; just clear the pointer
    } catch (err) {
      console.error('[Chat] remove person photo failed', err);
      alert('Could not remove photo: ' + ((err && err.message) || 'unknown error'));
    } finally {
      setMeBusy(false);
    }
  }

  // Reflect a person photo change everywhere: update the shared lookup (+ my own
  // pointer if it's me), then repaint whatever's on screen.
  function applyPersonPhoto(name, path) {
    personAvatarByName[name] = path;
    if (name === getIdentity().name) myAvatarPath = path;
    if (infoOpen) renderInfo();
    else if (currentConvId) applyThreadChrome();     // DM/group header person avatars
    refreshInboxHeaderIfVisible();                   // the "me" avatar on the pencil bar
    renderInboxIfVisible();                          // DM rows (other people)
  }

  function backToThreadFromInfo() {
    infoOpen = false;
    applyThreadChrome();
    renderThread();   // repaint the thread from cached threadMessages
    const box = document.getElementById('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  // ── compose: new DM / new group (Slice 3c) ──────────────────
  async function loadRoster() {
    const me = getIdentity();
    // Pull avatar_path too (sub-slice 3) to feed the shared name→avatar lookup;
    // fall back to name/role only if the column isn't there yet (pre-migration),
    // so compose never breaks.
    let { data, error } = await db.from('employees')
      .select('name, role, avatar_path').eq('active', true).in('role', OFFICE_ROLES).order('name');
    if (error && isMissingColumn(error)) {
      ({ data, error } = await db.from('employees')
        .select('name, role').eq('active', true).in('role', OFFICE_ROLES).order('name'));
    }
    if (error) { console.error('[Chat] roster load failed', error); compose.roster = []; return; }
    // Exclude the current user from every picker.
    compose.roster = (data || []).filter(p => p.name && p.name !== me.name);
    // Merge avatars into the shared lookup + sign them (best-effort).
    (data || []).forEach(r => { if (r.name && 'avatar_path' in r) personAvatarByName[r.name] = r.avatar_path || null; });
    await ensureSignedForPaths((data || []).map(r => r && r.avatar_path).filter(Boolean));
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

  // ── attachments (Slice 4a photo, 4b file; 4c voice reuses this path) ──
  // Upload FIRST, insert the message row ONLY on a successful upload, so a
  // failed upload never leaves a broken/pointer-less message row. kind is
  // 'photo' (image/* only, inline render) or 'file' (any type, download chip).
  async function uploadAndSendAttachment(file, kind, explicitCaption) {
    if (!file || !currentConvId) return;
    const id = getIdentity();
    if (!id.name || !id.role) {
      alert('Could not identify you on this board yet — try reopening it from CrisData.');
      return;
    }
    const isPhoto = kind === 'photo';
    if (isPhoto) {
      if (!file.type || file.type.indexOf('image/') !== 0) { alert('Please pick an image.'); return; }
      if (file.size > ATTACH_MAX_PHOTO_BYTES) { alert('That image is too large (max 10MB).'); return; }
    } else if (file.size > ATTACH_MAX_FILE_BYTES) {   // file / voice
      alert('That file is too large (max 25MB).'); return;
    }

    // Voice passes an explicit '' caption (its own panel, no text input);
    // photo/file read the composer's caption field.
    const input = document.getElementById('chat-input');
    const readFromInput = explicitCaption === undefined;
    const caption = readFromInput ? (input ? input.value.trim() : '') : explicitCaption;

    setAttachBusy(true);
    try {
      const fallbackExt = isPhoto ? 'jpg' : 'bin';
      const ext = (file.name.split('.').pop() || fallbackExt).toLowerCase().replace(/[^a-z0-9]/g, '') || fallbackExt;
      const path = `chat/${currentConvId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await db.storage.from(ATTACH_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (upErr) throw upErr;

      const { error: insErr } = await db.from('chat_messages').insert({
        conversation_id: currentConvId,
        sender_role: id.role,
        sender_name: id.name,
        message: caption || null,          // optional caption, or a standalone attachment
        attachment_path: path,
        attachment_kind: kind,
        attachment_name: file.name || null,
        attachment_mime: file.type || null,
      });
      if (insErr) throw insErr;

      if (readFromInput && input) input.value = '';   // caption consumed
      firePush(id, caption, { kind, name: file.name || null });
    } catch (err) {
      console.error('[Chat] attachment send failed', err);
      const hint = /bucket|not found|does not exist/i.test(err && err.message || '') ? ' (has the migration/bucket been set up?)' : '';
      alert((isPhoto ? 'Photo' : 'File') + ' failed to send: ' + ((err && err.message) || 'unknown error') + hint);
    } finally {
      setAttachBusy(false);
    }
  }

  function setAttachBusy(busy) {
    const btn = document.getElementById('chat-attach');
    if (btn) { btn.disabled = busy; btn.textContent = busy ? '⏳' : '📎'; }
  }

  // ── voice notes (Slice 4c) — MediaRecorder capture lifted from the tech
  //    Diagnosis recorder, adapted to a single clip per message. ──
  function openVoicePanel() {
    if (!currentConvId) return;
    voice = { state: 'idle', chunks: [], seconds: 0 };
    const panel = document.getElementById('chat-panel');
    if (panel) panel.classList.add('chat-voicing');
    renderVoicePanel();
  }

  function closeVoicePanel() {
    if (voice) {
      try { if (voice.recorder && voice.state === 'recording') voice.recorder.stop(); } catch (e) { /* ignore */ }
      if (voice.stream) voice.stream.getTracks().forEach(t => t.stop());
      if (voice.timer) clearInterval(voice.timer);
      if (voice.url) { try { URL.revokeObjectURL(voice.url); } catch (e) { /* ignore */ } }
    }
    voice = null;
    const panel = document.getElementById('chat-panel');
    if (panel) panel.classList.remove('chat-voicing');
    const vp = document.getElementById('chat-voice-panel');
    if (vp) vp.innerHTML = '';
  }

  async function startVoiceRecording() {
    if (!voice || voice.state === 'recording') return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      voice.error = 'Recording isn’t supported on this device.'; renderVoicePanel(); return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) {
      console.warn('[Chat] mic denied', e);
      if (!voice) return;   // panel closed while the prompt was up
      voice.error = 'Microphone access was blocked. Enable it for this app in Settings to record.';
      renderVoicePanel(); return;
    }
    if (!voice) { stream.getTracks().forEach(t => t.stop()); return; }   // closed during await
    voice.error = null;
    voice.stream = stream;
    const mime = pickAudioMime();
    let rec;
    try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) { rec = new MediaRecorder(stream); }
    voice.recorder = rec; voice.chunks = []; voice.seconds = 0; voice.state = 'recording'; voice.mime = mime;
    rec.ondataavailable = e => { if (e.data && e.data.size) voice.chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      if (!voice) return;
      if (voice.timer) { clearInterval(voice.timer); voice.timer = null; }
      const type = rec.mimeType || mime || 'audio/webm';
      voice.mime = type;
      voice.blob = new Blob(voice.chunks, { type });
      voice.url = voice.blob.size ? URL.createObjectURL(voice.blob) : null;
      voice.state = voice.blob.size ? 'preview' : 'idle';
      renderVoicePanel();
    };
    rec.start();
    voice.timer = setInterval(() => {
      if (!voice) return;
      voice.seconds++;
      const t = document.getElementById('chat-voice-timer');
      if (t) t.textContent = '● ' + mmss(voice.seconds) + ' / ' + mmss(VOICE_MAX_SECONDS);
      if (voice.seconds >= VOICE_MAX_SECONDS) stopVoiceRecording();
    }, 1000);
    renderVoicePanel();
  }

  function stopVoiceRecording() {
    if (voice && voice.recorder && voice.state === 'recording') {
      try { voice.recorder.stop(); } catch (e) { /* ignore */ }
    }
  }

  function discardVoiceClip() {
    if (!voice) return;
    if (voice.url) { try { URL.revokeObjectURL(voice.url); } catch (e) { /* ignore */ } }
    voice.blob = null; voice.url = null; voice.chunks = []; voice.seconds = 0; voice.state = 'idle';
    renderVoicePanel();
  }

  async function sendVoiceClip() {
    if (!voice || !voice.blob) return;
    const mime = voice.mime || 'audio/webm';
    // Wrap the recorded Blob in a File so it flows through uploadAndSendAttachment
    // unchanged (name → storage ext; kind='voice' → audio-player render).
    const file = new File([voice.blob], `Voice message.${audioExt(mime)}`, { type: mime });
    closeVoicePanel();                       // release mic/URL; File keeps the data
    await uploadAndSendAttachment(file, 'voice', '');
  }

  function renderVoicePanel() {
    const panel = document.getElementById('chat-voice-panel');
    if (!panel || !voice) return;
    if (voice.error) {
      panel.innerHTML = `<span class="chat-voice-err">${esc(voice.error)}</span>` +
        `<button type="button" class="chat-voice-x">Close</button>`;
      panel.querySelector('.chat-voice-x').addEventListener('click', closeVoicePanel);
      return;
    }
    if (voice.state === 'idle') {
      panel.innerHTML =
        `<button type="button" class="chat-voice-rec">🎤 Record</button>` +
        `<button type="button" class="chat-voice-x" title="Cancel">✕</button>`;
      panel.querySelector('.chat-voice-rec').addEventListener('click', startVoiceRecording);
      panel.querySelector('.chat-voice-x').addEventListener('click', closeVoicePanel);
    } else if (voice.state === 'recording') {
      panel.innerHTML =
        `<span class="chat-voice-timer" id="chat-voice-timer">● ${mmss(voice.seconds)} / ${mmss(VOICE_MAX_SECONDS)}</span>` +
        `<button type="button" class="chat-voice-stop">⏹ Stop</button>` +
        `<button type="button" class="chat-voice-x" title="Cancel">✕</button>`;
      panel.querySelector('.chat-voice-stop').addEventListener('click', stopVoiceRecording);
      panel.querySelector('.chat-voice-x').addEventListener('click', closeVoicePanel);
    } else if (voice.state === 'preview') {
      panel.innerHTML =
        `<audio class="chat-voice-audio" controls src="${voice.url}"></audio>` +
        `<button type="button" class="chat-voice-redo" title="Re-record">↺</button>` +
        `<button type="button" class="chat-voice-send">Send ➤</button>` +
        `<button type="button" class="chat-voice-x" title="Discard">🗑</button>`;
      panel.querySelector('.chat-voice-redo').addEventListener('click', discardVoiceClip);
      panel.querySelector('.chat-voice-send').addEventListener('click', sendVoiceClip);
      panel.querySelector('.chat-voice-x').addEventListener('click', closeVoicePanel);
    }
  }

  // ── realtime ──
  function bumpConversation(rec, incrementUnread) {
    const c = convById[rec.conversation_id];
    if (!c) return;
    c.lastMsg = {
      id: rec.id, message: rec.message, sender_name: rec.sender_name, created_at: rec.created_at,
      attachment_kind: rec.attachment_kind, attachment_name: rec.attachment_name,
      deleted_at: rec.deleted_at || null,
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

  // Read-receipt live flip: another member's chat_reads row (INSERT on first
  // read, UPDATE thereafter) for the OPEN thread advances readsByMember and
  // re-flips my sent-message icons. My own reads never affect my receipts, and
  // events for other conversations are ignored (client-side filter, mirroring
  // the message sub's single persistent channel). Needs chat_reads in the
  // realtime publication (migrations/20260721_chat_reads_realtime.sql) — until
  // then this is simply silent (receipts still correct on open, no live flip).
  function handleReadEvent(rec) {
    if (!rec || !rec.conversation_id || !rec.reader_name || !rec.last_read_at) return;
    if (rec.conversation_id !== currentConvId) return;   // only the open thread
    if (rec.reader_name === getIdentity().name) return;   // my own reads are irrelevant to my receipts
    const prev = readsByMember[rec.reader_name];
    if (prev && new Date(rec.last_read_at).getTime() <= new Date(prev).getTime()) return;  // monotonic
    readsByMember[rec.reader_name] = rec.last_read_at;
    updateReceipts();
  }

  // ── message delete (tombstone, OWN messages only, delete-for-everyone) ──────
  // Long-press (touch) / hover-⋯ (desktop) on my own live bubble → confirm →
  // remove the attachment file (best-effort) + null text + null attachment
  // pointer + set deleted_at/deleted_by, all in one atomic UPDATE so the row is
  // always left in a consistent tombstoned state. Realtime UPDATE propagates it
  // to everyone (targeted swap, not a full renderThread).
  async function performDelete(mid) {
    const me = getIdentity();
    const m = threadMessages.find(x => String(x.id) === String(mid));
    if (!m) return;
    if (!me.name || m.sender_name !== me.name || m.deleted_at) return;   // own-only, not already gone
    // 1. best-effort remove the stored file (never blocks the tombstone)
    if (m.attachment_path) {
      try { await db.storage.from(ATTACH_BUCKET).remove([m.attachment_path]); }
      catch (e) { console.warn('[Chat] attachment remove failed (ignored)', e); }
    }
    // 2+3. atomic tombstone UPDATE (text + attachment pointer nulled together)
    const nowIso = new Date().toISOString();
    const patch = {
      message: null,
      attachment_path: null, attachment_kind: null, attachment_name: null, attachment_mime: null,
      deleted_at: nowIso, deleted_by: me.name,
    };
    const { error } = await db.from('chat_messages').update(patch).eq('id', m.id);
    if (error) {
      console.error('[Chat] delete failed', error);
      const hint = /column|deleted_at|deleted_by/i.test(error.message || '') ? ' (has the migration been run?)' : '';
      alert('Could not delete: ' + ((error.message) || 'unknown error') + hint);
      return;
    }
    // optimistic — realtime will also deliver the same UPDATE (idempotent)
    const rec = { id: m.id, conversation_id: m.conversation_id, sender_name: m.sender_name, created_at: m.created_at, deleted_at: nowIso, deleted_by: me.name };
    tombstoneOpenThreadBubble(rec);
    bumpInboxPreviewIfLatest(rec);
  }

  // Swap ONE bubble in the open thread to its tombstone in place (no full
  // renderThread → scroll position + day dividers untouched). Idempotent.
  function tombstoneOpenThreadBubble(rec) {
    if (!rec || rec.conversation_id !== currentConvId) return;
    const idx = threadMessages.findIndex(x => String(x.id) === String(rec.id));
    if (idx < 0) return;
    threadMessages[idx] = Object.assign({}, threadMessages[idx], {
      message: null, attachment_path: null, attachment_kind: null, attachment_name: null, attachment_mime: null,
      deleted_at: rec.deleted_at, deleted_by: rec.deleted_by,
    });
    const m = threadMessages[idx];
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const el = [...box.querySelectorAll('.chat-msg[data-mid]')].find(n => n.getAttribute('data-mid') === String(rec.id));
    if (!el) return;
    const me = getIdentity();
    el.className = `chat-msg ${m.sender_name === me.name ? 'me' : 'them'}`;   // drops the delete affordance
    el.removeAttribute('data-own');
    el.innerHTML =
      `<div class="chat-msg-sender">${esc(m.sender_name)}</div>` +
      bubbleInner(m) +
      `<div class="chat-msg-time">${formatChatTime(m.created_at)}</div>`;   // no receipt on a tombstone
  }

  // If the deleted message is a conversation's cached latest, update its inbox
  // preview to the tombstone label. Not the latest → preview unaffected.
  function bumpInboxPreviewIfLatest(rec) {
    const c = convById[rec.conversation_id];
    if (!c || !c.lastMsg || String(c.lastMsg.id) !== String(rec.id)) return;
    c.lastMsg = Object.assign({}, c.lastMsg, {
      message: null, attachment_kind: null, attachment_name: null, deleted_at: rec.deleted_at,
    });
    renderInboxIfVisible();
  }

  // Realtime chat_messages UPDATE — this slice only acts on newly-set deleted_at.
  function handleMessageUpdate(rec) {
    if (!rec || !rec.conversation_id || !rec.deleted_at) return;
    if (!convById[rec.conversation_id]) return;   // not a conversation I'm in / loaded
    tombstoneOpenThreadBubble(rec);               // live swap if it's the open thread
    bumpInboxPreviewIfLatest(rec);                // inbox preview if it was the latest
  }

  // ── delete affordance: a small floating menu with "Delete" ──
  let msgMenuEl = null;
  function closeMsgMenu() {
    if (msgMenuEl) { msgMenuEl.remove(); msgMenuEl = null; }
    document.removeEventListener('click', onMsgMenuOutside, true);
  }
  function onMsgMenuOutside(e) { if (msgMenuEl && !msgMenuEl.contains(e.target)) closeMsgMenu(); }
  function openMsgMenu(mid, anchor) {
    closeMsgMenu();
    const menu = document.createElement('div');
    menu.className = 'chat-msg-menu';
    menu.innerHTML = `<button type="button" data-act="delete">Delete</button>`;
    document.body.appendChild(menu);   // body-level + position:fixed → never clipped
    msgMenuEl = menu;
    const mw = menu.offsetWidth || 120, mh = menu.offsetHeight || 40;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = anchor.left, top = (anchor.bottom != null ? anchor.bottom : anchor.top) + 4;
    if (left + mw > vw - 8) left = vw - 8 - mw;
    if (left < 8) left = 8;
    if (top + mh > vh - 8) top = (anchor.top != null ? anchor.top : anchor.bottom) - mh - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.querySelector('[data-act="delete"]').addEventListener('click', () => {
      closeMsgMenu();
      if (window.confirm('Delete this message?')) performDelete(mid);
    });
    setTimeout(() => document.addEventListener('click', onMsgMenuOutside, true), 0);
  }

  // Delegated on the stable #chat-messages container (survives innerHTML repaints).
  // Desktop: click the hover ⋯. Touch: long-press my own bubble.
  function wireMessageActions() {
    const box = document.getElementById('chat-messages');
    if (!box || box.__msgActionsWired) return;
    box.__msgActionsWired = true;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.chat-msg-menu-btn');
      if (!btn) return;
      e.stopPropagation();
      const row = btn.closest('.chat-msg[data-mid]');
      if (row) openMsgMenu(row.getAttribute('data-mid'), btn.getBoundingClientRect());
    });
    let lpTimer = null, lpMoved = false;
    const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    box.addEventListener('touchstart', (e) => {
      const row = e.target.closest && e.target.closest('.chat-msg[data-own][data-mid]');
      if (!row) return;
      lpMoved = false;
      const t = e.touches[0], x = t.clientX, y = t.clientY;
      lpTimer = setTimeout(() => { if (!lpMoved) openMsgMenu(row.getAttribute('data-mid'), { left: x, top: y, bottom: y }); }, 500);
    }, { passive: true });
    box.addEventListener('touchmove', () => { lpMoved = true; clearLp(); }, { passive: true });
    box.addEventListener('touchend', clearLp, { passive: true });
    box.addEventListener('touchcancel', clearLp, { passive: true });
  }

  function subscribeRealtime() {
    if (chatRealtimeChannel) { db.removeChannel(chatRealtimeChannel); chatRealtimeChannel = null; }
    chatRealtimeChannel = db.channel('chat-live')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        ({ new: rec }) => handleIncoming(rec))
      // Message delete (tombstone): UPDATE on chat_messages with deleted_at set.
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_messages' },
        ({ new: rec }) => handleMessageUpdate(rec))
      // Read receipts: INSERT + UPDATE on chat_reads (event '*'; DELETE carries
      // no `new` and is guarded away in the handler).
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'chat_reads' },
        ({ new: rec }) => handleReadEvent(rec))
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
  wireMessageActions();   // own-message delete: long-press (touch) / hover-⋯ (desktop)

  // Attach control (Slice 4a photo, 4b file) — injected into the composer so no
  // board markup changes. Tapping 📎 opens a Photo/File chooser: Photo keeps the
  // 4a image flow (inline render), File takes any type (download chip). 4c will
  // add a Voice entry to the same menu.
  (function mountAttachControl() {
    const row = inputEl ? inputEl.closest('.chat-input-row') : document.querySelector('.chat-input-row');
    if (!row || document.getElementById('chat-attach')) return;

    const wrap = document.createElement('div');
    wrap.className = 'chat-attach-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'chat-attach';
    btn.className = 'chat-attach-btn';
    btn.title = 'Attach';
    btn.textContent = '📎';

    const menu = document.createElement('div');
    menu.className = 'chat-attach-menu';
    menu.style.display = 'none';
    menu.innerHTML =
      `<button type="button" data-attach="photo">📷 Photo</button>` +
      `<button type="button" data-attach="file">📎 File</button>` +
      `<button type="button" data-attach="voice">🎤 Voice</button>`;

    const photoInput = document.createElement('input');
    photoInput.type = 'file'; photoInput.accept = 'image/*'; photoInput.style.display = 'none';
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.style.display = 'none';   // no accept → any type

    const closeMenu = () => { menu.style.display = 'none'; };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    });
    menu.querySelector('[data-attach="photo"]').addEventListener('click', () => { closeMenu(); photoInput.click(); });
    menu.querySelector('[data-attach="file"]').addEventListener('click', () => { closeMenu(); fileInput.click(); });
    menu.querySelector('[data-attach="voice"]').addEventListener('click', () => { closeMenu(); openVoicePanel(); });
    document.addEventListener('click', (e) => { if (menu.style.display !== 'none' && !wrap.contains(e.target)) closeMenu(); });

    photoInput.addEventListener('change', () => {
      const file = photoInput.files && photoInput.files[0];
      photoInput.value = '';                 // allow re-picking the same file
      if (file) uploadAndSendAttachment(file, 'photo');
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) uploadAndSendAttachment(file, 'file');
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    row.insertBefore(wrap, row.firstChild);  // leftmost in the composer
    row.appendChild(photoInput);
    row.appendChild(fileInput);

    // Voice record panel — sibling of the input row inside .chat-panel, shown
    // (input row hidden) only while .chat-voicing is set.
    if (!document.getElementById('chat-voice-panel') && row.parentElement) {
      const vp = document.createElement('div');
      vp.className = 'chat-voice-panel';
      vp.id = 'chat-voice-panel';
      row.parentElement.insertBefore(vp, row);
    }
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
