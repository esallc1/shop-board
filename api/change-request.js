/* ============================================================
   api/change-request.js — submit / triage a Requests & Feedback item.

   POST { action: 'create', type, priority, body, screenshot_path, screenshot_name,
          screenshot_mime, submitted_by_id, submitted_by_name, submitted_by_role,
          context_board, context_view, context_ro, app_version, user_agent }
     → inserts one `change_requests` row (status defaults to 'new').
       Returns { request: { ... } }.
   POST { action: 'triage', id, status, owner_note }
     → updates status (+ owner_note / owner_note_at when a note is given).
       Returns { request: { ... } }.

   ── WHY A SERVER ENDPOINT (not optional) ──
   `change_requests` is RLS anon-SELECT only — the board's anon key can read the
   triage/list but can't create or triage one (same posture as `announcements` /
   `calls`). Writing runs here with the service-role key, mirroring
   api/announcement.js. We do NOT widen anon writes.

   ── "BODY OR SCREENSHOT" (like desk-appointment's "phone OR customer_id") ──
   A submission must carry a non-blank note OR a screenshot. The screenshot is
   uploaded client-side to the crisdata-attachments bucket under reports/<uuid>/…
   BEFORE this call; only the path/name/mime are posted here.

   ── HONEST SECURITY NOTE ──
   This endpoint stops anon table writes and validates input; it does NOT verify
   WHO is calling (there is no server-verifiable identity yet — see settings.md
   §3/§6). "Only the owner triages" is a cosmetic client gate today, same posture
   as announcements. It tightens for free once the auth token lands.
   ============================================================ */

const SUPABASE_URL = 'https://hygemiszxwmyrkmhbjub.supabase.co';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A screenshot path we accept is always one WE minted client-side:
// reports/<uuid>/<filename>. Reject anything else so a caller can't point the
// row at an arbitrary object in the bucket.
const SCREENSHOT_PATH_RE = /^reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/.+/i;

export const TYPES = ['bug', 'idea'];
export const PRIORITIES = ['immediate', 'high', 'normal', 'low'];
export const STATUSES = ['new', 'reviewing', 'in_progress', 'done', 'not_now', 'wont_build'];
export const MAX_BODY = 5000;
export const MAX_NOTE = 2000;

// Validate + normalize the body. Pure + exported so the contract is locked by a
// test. Two actions: 'create' (default) and 'triage'.
export function parseChangeRequestBody(body) {
  const b = body || {};
  const action = b.action === 'triage' ? 'triage' : 'create';
  const trim = (v, n) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s.slice(0, n) : null;
  };

  if (action === 'triage') {
    const id = b.id == null ? '' : String(b.id);
    if (!UUID_RE.test(id)) return { ok: false, error: 'id must be a uuid' };
    if (!STATUSES.includes(b.status)) return { ok: false, error: 'status is not valid' };
    const owner_note = trim(b.owner_note, MAX_NOTE);
    return { ok: true, action: 'triage', id, status: b.status, owner_note };
  }

  // create
  if (!TYPES.includes(b.type)) return { ok: false, error: 'type must be bug or idea' };
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  const bodyText = b.body == null ? null : (String(b.body).trim() || null);
  if (bodyText && bodyText.length > MAX_BODY) return { ok: false, error: `note too long (max ${MAX_BODY})` };

  let screenshot_path = null, screenshot_name = null, screenshot_mime = null;
  if (b.screenshot_path != null && String(b.screenshot_path).trim() !== '') {
    screenshot_path = String(b.screenshot_path).trim();
    if (!SCREENSHOT_PATH_RE.test(screenshot_path)) {
      return { ok: false, error: 'screenshot_path must be reports/<uuid>/<file>' };
    }
    screenshot_name = trim(b.screenshot_name, 200);
    screenshot_mime = trim(b.screenshot_mime, 120);
  }

  if (!bodyText && !screenshot_path) {
    return { ok: false, error: 'a note or a screenshot is required' };
  }

  return {
    ok: true,
    action: 'create',
    row: {
      type: b.type,
      priority,
      body: bodyText,
      screenshot_path,
      screenshot_name,
      screenshot_mime,
      submitted_by_id: (b.submitted_by_id != null && UUID_RE.test(String(b.submitted_by_id))) ? String(b.submitted_by_id) : null,
      submitted_by_name: trim(b.submitted_by_name, 120),
      submitted_by_role: trim(b.submitted_by_role, 40),
      context_board: trim(b.context_board, 40),
      context_view: trim(b.context_view, 60),
      context_ro: trim(b.context_ro, 60),
      app_version: trim(b.app_version, 80),
      user_agent: trim(b.user_agent, 500),
      status: 'new',
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = parseChangeRequestBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[change-request] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const headers = {
    apikey: key, Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  };

  try {
    if (parsed.action === 'triage') {
      const patch = { status: parsed.status };
      if (parsed.owner_note !== null) { patch.owner_note = parsed.owner_note; patch.owner_note_at = new Date().toISOString(); }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/change_requests?id=eq.${parsed.id}`, {
        method: 'PATCH', headers, body: JSON.stringify(patch),
      });
      if (!r.ok) { console.error('[change-request] triage failed', r.status, await r.text()); return res.status(502).json({ error: 'triage failed' }); }
      const j = await r.json();
      return res.status(200).json({ request: (j && j[0]) || null });
    }

    const ins = await fetch(`${SUPABASE_URL}/rest/v1/change_requests`, {
      method: 'POST', headers, body: JSON.stringify(parsed.row),
    });
    if (!ins.ok) { console.error('[change-request] insert failed', ins.status, await ins.text()); return res.status(502).json({ error: 'create failed' }); }
    const j = await ins.json();
    return res.status(200).json({ request: (j && j[0]) || null });
  } catch (e) {
    console.error('[change-request] threw', e);
    return res.status(502).json({ error: 'request failed' });
  }
}
