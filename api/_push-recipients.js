/* ============================================================
   _push-recipients.js — pure recipient-resolution helpers for
   api/send-push.js (Team Chat push, Slice 3d).

   Intentionally free of web-push and any network/env access so the
   resolution logic is unit-testable in isolation (see send-push.test.js).
   ============================================================ */

// Recipients of a conversation push = every DISTINCT member name in the
// conversation MINUS the sender. A group returns all the other members; a DM
// returns the single other person. Null/blank names, duplicates, and the
// sender's own name are dropped (so a sender never pushes themselves).
export function recipientNamesFromMembers(members, senderName) {
  const seen = new Set();
  const out = [];
  for (const m of members || []) {
    const name = m && m.member_name;
    if (!name || name === senderName || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Build the value for a PostgREST `subscriber_name=in.(...)` filter: each name
// double-quoted (embedded double-quotes doubled per PostgREST escaping), joined
// with commas. Names contain spaces (e.g. "Daiana Mendez"), so quoting is
// required. The caller URL-encodes the returned string.
export function buildSubscriberInList(names) {
  return names.map((n) => `"${String(n).replace(/"/g, '""')}"`).join(',');
}

// Notification title/body by conversation type (Slice 3e), so a group message
// and a DM read differently on the lock screen:
//   • group → title = the group's title (fallback "Group" so a titleless group
//             never shows an empty title); body = "<sender>: <preview>"
//   • dm     → title = senderName; body = preview   (unchanged behavior)
// A null/unknown conversation falls back to DM-style formatting. Body is capped
// at ~120 chars INCLUDING the "<sender>: " prefix on group bodies. (iOS already
// shows the app name "CrisData" as the group header, so no title suffix here.)
export function formatPushNotification(conversation, senderName, messagePreview) {
  const preview = String(messagePreview == null ? '' : messagePreview);
  if (conversation && conversation.type === 'group') {
    const groupTitle = (conversation.title && String(conversation.title).trim()) || 'Group';
    return {
      title: groupTitle,
      body: `${senderName}: ${preview}`.slice(0, 120),
    };
  }
  return {
    title: senderName || 'CrisData',
    body: preview.slice(0, 120),
  };
}
