/* ============================================================
   api/announcement.js — post / remove an office announcement.

   POST { action: 'create', message, style, expires_at, posted_by_name }
     → retires any currently-active announcement, then inserts the new one.
       Returns { announcement: { ... } }.
   POST { action: 'remove', id }
     → stamps removed_at on that row. Returns { ok: true }.

   ── WHY A SERVER ENDPOINT (not optional) ──
   `announcements` is RLS anon-SELECT only — the board's anon key can read the
   banner but can't create or retire one (same posture as `calls`). Posting runs
   here with the service-role key, mirroring api/desk-appointment.js. We do NOT
   widen anon writes.

   ── ONE ACTIVE AT A TIME (v1) ──
   The banner shows the single most-recent active announcement. To keep that
   unambiguous, `create` first stamps removed_at on every still-active row, then
   inserts the new one — so there is only ever one active row. (A rotating
   carousel of several is a later phase.)
   ============================================================ */

const SUPABASE_URL = 'https://hygemiszxwmyrkmhbjub.supabase.co';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STYLES = ['normal', 'important'];
export const ROLES = ['manager', 'advisor', 'bookkeeping'];   // the office boards an announcement can target
export const MAX_MESSAGE = 500;

// Validate + normalize the body. Pure + exported so the contract is locked by a
// test. Two actions: 'create' (default) and 'remove'.
export function parseAnnouncementBody(body) {
  const b = body || {};
  const action = b.action === 'remove' ? 'remove' : 'create';

  if (action === 'remove') {
    const id = b.id == null ? '' : String(b.id);
    if (!UUID_RE.test(id)) return { ok: false, error: 'id must be a uuid' };
    return { ok: true, action: 'remove', id };
  }

  const message = String(b.message == null ? '' : b.message).trim();
  if (!message) return { ok: false, error: 'message is required' };
  if (message.length > MAX_MESSAGE) return { ok: false, error: `message too long (max ${MAX_MESSAGE})` };
  const style = STYLES.includes(b.style) ? b.style : 'normal';
  let expires_at = null;
  if (b.expires_at != null && b.expires_at !== '') {
    if (typeof b.expires_at !== 'string' || Number.isNaN(Date.parse(b.expires_at))) {
      return { ok: false, error: 'expires_at must be an ISO timestamp or null' };
    }
    expires_at = b.expires_at;
  }
  const posted_by_name = b.posted_by_name ? String(b.posted_by_name).slice(0, 120) : null;
  // audience = any combo of the three roles. Absent → all three (a broadcast).
  // Present but empty (after filtering to known roles) → rejected: an
  // announcement nobody can see is a mistake, not a valid state.
  let audience;
  if (b.audience == null) {
    audience = ROLES.slice();
  } else {
    if (!Array.isArray(b.audience)) return { ok: false, error: 'audience must be an array of roles' };
    audience = [...new Set(b.audience.filter(r => ROLES.includes(r)))];
    if (audience.length === 0) return { ok: false, error: 'pick at least one audience (Manager / Advisor / Bookkeeping)' };
  }
  return { ok: true, action: 'create', row: { message, style, expires_at, posted_by_name, audience } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = parseAnnouncementBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[announcement] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const headers = {
    apikey: key, Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  };
  const nowIso = new Date().toISOString();

  try {
    if (parsed.action === 'remove') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/announcements?id=eq.${parsed.id}&removed_at=is.null`, {
        method: 'PATCH', headers, body: JSON.stringify({ removed_at: nowIso }),
      });
      if (!r.ok) { console.error('[announcement] remove failed', r.status, await r.text()); return res.status(502).json({ error: 'remove failed' }); }
      return res.status(200).json({ ok: true });
    }

    // create: retire every active row first (one-active-at-a-time), then insert.
    const retire = await fetch(`${SUPABASE_URL}/rest/v1/announcements?removed_at=is.null`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ removed_at: nowIso }),
    });
    if (!retire.ok) { console.error('[announcement] retire-active failed', retire.status, await retire.text()); return res.status(502).json({ error: 'create failed' }); }

    const ins = await fetch(`${SUPABASE_URL}/rest/v1/announcements?select=id,message,style,posted_by_name,created_at,expires_at,audience`, {
      method: 'POST', headers, body: JSON.stringify(parsed.row),
    });
    if (!ins.ok) { console.error('[announcement] insert failed', ins.status, await ins.text()); return res.status(502).json({ error: 'create failed' }); }
    const j = await ins.json();
    return res.status(200).json({ announcement: (j && j[0]) || null });
  } catch (e) {
    console.error('[announcement] threw', e);
    return res.status(502).json({ error: 'request failed' });
  }
}
