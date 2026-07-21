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
