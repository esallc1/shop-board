/* ============================================================
   team-chat.js — single shared Team Chat component.

   Extracted (behaviour-for-behaviour) from the four board copies in
   gm-board / advisor-board / owner-board / bookkeeping-board, which were
   ~250 near-identical lines each. Parameterised via initTeamChat(config).

   Markup contract (identical on every board that mounts it):
     #chat-channels  #chat-messages  #chat-input  #chat-send
     #emoji-btn      #emoji-popover
   Config supplies the board-specific bits: channel list, live identity,
   unread-badge element id, a visibility predicate (tab vs panel), and
   optionally the channel key to relabel with the live owner's name.

   Slice-1 additions (additive, no UX change):
   • Durable read-state via a `chat_reads` table so unread survives reload
     and syncs across devices. Degrades to today's in-memory-only counting
     if that table isn't migrated yet (see migrations/20260720_chat_reads.sql).

   initTeamChat(config) returns:
     { refetch, resubscribe, getChannel, onSurfaceShown }
   which each board wires to its own surface (sidebar tab vs floating panel).
   ============================================================ */
function initTeamChat(config) {
  const db = config.db;
  // Read identity LIVE at every use. Each board resolves its session
  // asynchronously and REASSIGNS its CHAT_IDENTITY to a NEW object once the
  // name/role are known — so a reference captured here at init would stay
  // pinned to the initial {name:null, role:null} object and the send guard
  // would wrongly reject a sender the board already knows. config.getIdentity()
  // always reflects the board's current value; config.identity remains a
  // fallback for any caller that passes a live-mutated object instead.
  const getIdentity = () =>
    (typeof config.getIdentity === 'function' ? config.getIdentity() : config.identity) || {};
  const CHAT_CHANNELS = config.channels || [];
  const badgeId = config.badgeId || 'teamchat-unread-badge';
  const isSurfaceVisible = config.isSurfaceVisible || (() => true);
  const ownerNameChannelKey = config.ownerNameChannelKey || null;

  let CURRENT_CHANNEL = (CHAT_CHANNELS[0] && CHAT_CHANNELS[0].key) || 'group';
  let chatMessages = [];
  let chatRealtimeChannel = null;
  let chatUnreadCounts = {};
  let chatAudioCtx = null;

  // ── durable read-state (chat_reads) — with in-memory fallback ──
  let readAvailable = true;    // flips false the first time chat_reads looks unmigrated
  let readSyncing = false;     // guards overlapping syncs
  const lastReadAt = {};       // channel -> ISO string of that reader's last_read_at

  function esc(s) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function formatChatTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function isTeamChatVisible(channel) {
    return isSurfaceVisible() && CURRENT_CHANNEL === channel;
  }

  // ── alert audio (synthesized beep; no external asset) ──
  function unlockChatAudio() {
    if (!chatAudioCtx) {
      try { chatAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    }
    if (chatAudioCtx.state === 'suspended') chatAudioCtx.resume().catch(() => {});
  }
  // Unlock on the very first interaction anywhere on the page — any trusted
  // gesture satisfies the browser's autoplay policy, so this doesn't depend on
  // the user opening Team Chat before a message arrives.
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
    // Resume is async — schedule the tone only after it resolves, else the
    // oscillator can be scheduled against a still-suspended context and never sound.
    if (chatAudioCtx.state === 'suspended') {
      chatAudioCtx.resume().then(fire).catch(() => {});
    } else {
      fire();
    }
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
    const channelLabel = (CHAT_CHANNELS.find(c => c.key === rec.channel) || {}).label || rec.channel;
    const el = document.createElement('div');
    el.className = 'chat-toast';
    el.innerHTML = `
      <div class="chat-toast-channel">${esc(channelLabel)}</div>
      <div class="chat-toast-sender">${esc(rec.sender_name)}</div>
      <div class="chat-toast-msg">${esc(rec.message)}</div>
    `;
    el.addEventListener('click', () => el.remove());
    box.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ── unread badge ──
  function updateChatUnreadBadge() {
    const badge = document.getElementById(badgeId);
    if (!badge) return;
    const total = Object.values(chatUnreadCounts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      badge.textContent = total > 9 ? '9+' : String(total);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  function maybeAlertNewMessage(rec) {
    if (!rec || !getIdentity().name || !getIdentity().role) return; // pre-login: identity not resolved yet
    if (rec.sender_name === getIdentity().name) return;        // self-sent
    playChatAlertSound();                                 // sound always plays, even for the open channel
    if (isTeamChatVisible(rec.channel)) return;           // already looking at this exact channel — skip toast/badge
    chatUnreadCounts[rec.channel] = (chatUnreadCounts[rec.channel] || 0) + 1;
    updateChatUnreadBadge();
    showChatToast(rec);
  }

  // ── channel tabs ──
  function renderChannelTabs() {
    const wrap = document.getElementById('chat-channels');
    if (!wrap) return;
    wrap.innerHTML = CHAT_CHANNELS.map(c =>
      `<button class="chat-channel-btn${c.key === CURRENT_CHANNEL ? ' active' : ''}" data-channel="${c.key}">${esc(c.label)}</button>`
    ).join('');
    wrap.querySelectorAll('[data-channel]').forEach(btn => {
      btn.addEventListener('click', () => switchChatChannel(btn.dataset.channel));
    });
  }

  // Pull the real owner's name from `employees` (same dynamic-source pattern as
  // the Tech dropdown) to label the board's owner channel. Falls back to the
  // generic "Owner" label. Only runs when the board configures a key.
  async function loadOwnerChannelLabel() {
    if (!ownerNameChannelKey) return;
    const { data, error } = await db
      .from('employees').select('name')
      .eq('role', 'owner').eq('active', true)
      .order('name').limit(1);
    if (error) { console.error('[Chat] load owner label failed', error); return; }
    const entry = CHAT_CHANNELS.find(c => c.key === ownerNameChannelKey);
    if (entry) entry.label = (data && data[0] && data[0].name) ? data[0].name : 'Owner';
    renderChannelTabs();
  }

  // ── messages ──
  async function loadChatMessages(channel) {
    const { data, error } = await db.from('chat_messages').select('*').eq('channel', channel).order('created_at');
    if (error) { console.error('[Chat] load failed', error); chatMessages = []; }
    else chatMessages = data || [];
    renderChat();
  }

  function handleIncomingChatMessage(rec) {
    if (!rec) return;
    if (rec.channel === CURRENT_CHANNEL) {
      chatMessages.push(rec);
      renderChat();
    }
    maybeAlertNewMessage(rec);
  }

  function subscribeChatChannel() {
    if (chatRealtimeChannel) {
      db.removeChannel(chatRealtimeChannel);
      chatRealtimeChannel = null;
    }
    let channel = db.channel('chat-live');
    CHAT_CHANNELS.forEach(c => {
      channel = channel.on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `channel=eq.${c.key}` },
        ({ new: rec }) => handleIncomingChatMessage(rec)
      );
    });
    chatRealtimeChannel = channel.subscribe();
  }

  function switchChatChannel(channel) {
    CURRENT_CHANNEL = channel;
    renderChannelTabs();
    loadChatMessages(channel);
    markChannelRead(channel);
  }

  function renderChat() {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    box.innerHTML = chatMessages.map(m => `
      <div class="chat-msg ${m.sender_name === getIdentity().name ? 'me' : 'them'}">
        <div class="chat-msg-sender">${esc(m.sender_name)}</div>
        <div class="chat-msg-bubble">${esc(m.message)}</div>
        <div class="chat-msg-time">${formatChatTime(m.created_at)}</div>
      </div>`).join('');
    box.scrollTop = box.scrollHeight;
  }

  async function sendChatMsg() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    const id = getIdentity();
    if (!id.name || !id.role) {
      alert('Could not identify you on this board yet — try reopening it from CrisData.');
      return;
    }
    input.value = '';
    const channel = CURRENT_CHANNEL;
    const { error } = await db.from('chat_messages').insert({
      channel: channel,
      sender_role: id.role,
      sender_name: id.name,
      message: text,
    });
    if (error) {
      console.error('[Chat] send failed', error);
      alert('Message failed to send: ' + error.message);
      return;
    }
    // Best-effort closed-phone push to the other participants (sub-slice 2c).
    // Fire-and-forget: the message already saved — a push failure must NEVER
    // surface to the sender or block sending. Identity is read live (above).
    try {
      fetch('/api/send-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: channel,
          senderName: id.name,
          senderRole: id.role,
          messagePreview: text,
        }),
      }).catch(function (e) { console.warn('[Chat] push notify failed (ignored)', e); });
    } catch (e) { /* swallow — never affects the send */ }
  }

  // ── read-state ops ──────────────────────────────────────────
  function isMissingTable(err) {
    const code = err && err.code || '', msg = err && err.message || '';
    return code === '42P01' || code === 'PGRST205' ||
      /relation .* does not exist/i.test(msg) || /could not find the table/i.test(msg);
  }

  // Mark a channel read: clear its in-memory count (today's behaviour) AND
  // upsert last_read_at=now so it survives reload / syncs across devices.
  // Best-effort — if chat_reads isn't migrated yet we just do the in-memory clear.
  async function markChannelRead(channel) {
    if (chatUnreadCounts[channel]) {
      chatUnreadCounts[channel] = 0;
      updateChatUnreadBadge();
    }
    if (!readAvailable || !getIdentity().name) return;
    const nowIso = new Date().toISOString();
    lastReadAt[channel] = nowIso;
    const { error } = await db.from('chat_reads').upsert(
      { channel, reader_role: getIdentity().role || null, reader_name: getIdentity().name, last_read_at: nowIso },
      { onConflict: 'channel,reader_name' }
    );
    if (error) {
      if (isMissingTable(error)) readAvailable = false;   // degrade silently to in-memory only
      else console.warn('[Chat] read upsert failed', error.message);
    }
  }

  // Reconcile unread counts against chat_reads. authoritative=true (focus)
  // trusts the DB (allows decreases from reads on another device);
  // authoritative=false (initial load) uses max() so a live increment that
  // raced the count query isn't lost. Channels never marked read stay at their
  // in-memory value (0 on a fresh load — matches today).
  async function syncReadState(authoritative) {
    if (!readAvailable || !getIdentity().name || readSyncing) return;
    readSyncing = true;
    try {
      const { data, error } = await db.from('chat_reads')
        .select('channel,last_read_at').eq('reader_name', getIdentity().name);
      if (error) {
        if (isMissingTable(error)) readAvailable = false;
        else console.warn('[Chat] read sync failed', error.message);
        return;
      }
      (data || []).forEach(r => { lastReadAt[r.channel] = r.last_read_at; });
      for (const c of CHAT_CHANNELS) {
        const lr = lastReadAt[c.key];
        if (!lr) continue;   // never read → leave as-is (0 on fresh load)
        const { count, error: cErr } = await db.from('chat_messages')
          .select('*', { count: 'exact', head: true })
          .eq('channel', c.key).gt('created_at', lr).neq('sender_name', getIdentity().name);
        if (cErr) { if (isMissingTable(cErr)) { readAvailable = false; return; } continue; }
        const n = count || 0;
        chatUnreadCounts[c.key] = authoritative ? n : Math.max(chatUnreadCounts[c.key] || 0, n);
      }
      updateChatUnreadBadge();
    } finally {
      readSyncing = false;
    }
  }

  // Identity resolves asynchronously on the board (captureSessionAndGreet).
  // Poll briefly, then hydrate persisted unread once it's known.
  (function hydrateWhenIdentityReady() {
    if (getIdentity().name) { syncReadState(false); return; }
    let tries = 0;
    const iv = setInterval(() => {
      if (getIdentity().name) { clearInterval(iv); syncReadState(false); }
      else if (++tries >= 25) clearInterval(iv);   // ~10s
    }, 400);
  })();

  // Reconcile on refocus — catches reads/messages from another device.
  window.addEventListener('focus', () => syncReadState(true));

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

  // ── initial mount ──
  renderChannelTabs();
  loadChatMessages(CURRENT_CHANNEL);
  subscribeChatChannel();
  loadOwnerChannelLabel();
  renderEmojiPopover();

  // Board wires these to its own surface (sidebar tab / floating panel).
  return {
    refetch: () => loadChatMessages(CURRENT_CHANNEL),
    resubscribe: () => subscribeChatChannel(),
    getChannel: () => chatRealtimeChannel,
    // Call when the chat surface becomes visible: unlock audio, mark the open
    // channel read, and re-apply scroll-to-bottom (a no-op while hidden because
    // a display:none element reports scrollHeight 0).
    onSurfaceShown: () => {
      unlockChatAudio();
      markChannelRead(CURRENT_CHANNEL);
      const box = document.getElementById('chat-messages');
      if (box) box.scrollTop = box.scrollHeight;
    },
  };
}
