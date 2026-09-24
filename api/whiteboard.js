/* ============================================================
   api/whiteboard.js — every write the advisor board's Whiteboard makes.
   Wiring: docs/wiring/whiteboard.md §7. Tables: migrations/20260924_whiteboard_*.sql.

   POST { action: 'add',      kind: 'note'|'parts', text, ro_id? }
   POST { action: 'clear',    id, reason: 'erased'|'arrived' }   ('arrived' = parts only)
   POST { action: 'undo',     id }                               (un-clear: back on the board)
   POST { action: 'called',   ro_id }                            ("Called ✓" on a Ready line)
   POST { action: 'uncalled', ro_id }                            (undo a mis-tap)

   ── WHO ──
   requireUser(req) FIRST: a live Supabase session that maps to exactly ONE
   ACTIVE employees row, else a flat 401 and nothing is read (same gate as
   api/messenger.js). Then the service-role key does the write — the browser
   can only READ whiteboard_* (staff, via is_staff()); it can't write them.

   ── WHAT EACH ACTION MAY TOUCH ── (fixed columns only)
   add      → a NEW whiteboard_items row: kind, text, ro_id, created_by, created_by_name.
   clear    → cleared_at, cleared_by, cleared_by_name, cleared_reason — only on a line that
              isn't cleared yet. Nothing is ever deleted.
   undo     → the same four cleared_* columns back to null.
   called   → whiteboard_pickup_calls (one row per RO): called_at, called_by, called_by_name,
              updated_at. Only for an RO whose status is 'invoice'.
   uncalled → called_* back to null (the row stays).
   Who and when are ALWAYS stamped here from requireUser + the server clock —
   anything the browser sends for them is ignored. repair_orders is only READ.
   ============================================================ */
import { requireUser } from './_lib/require-user.js';

const PROD_SUPABASE = 'https://hygemiszxwmyrkmhbjub.supabase.co';
export const MAX_TEXT = 500;
export const ACTIONS = ['add', 'clear', 'undo', 'called', 'uncalled'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_COLS = 'id,kind,text,ro_id,created_by,created_by_name,created_at,cleared_at,cleared_by,cleared_by_name,cleared_reason';
const CALL_COLS = 'ro_id,called_at,called_by,called_by_name,updated_at';

/* ── Pure: validate the body (exported, tested) ──────────────────────────── */
// Returns { ok:true, action, ... } or { ok:false, error }.
export function parseBody(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const action = b.action;
  if (!ACTIONS.includes(action)) return { ok: false, error: 'action must be add, clear, undo, called or uncalled' };

  if (action === 'add') {
    if (b.kind !== 'note' && b.kind !== 'parts') return { ok: false, error: 'kind must be note or parts' };
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) return { ok: false, error: 'text is required' };
    if (text.length > MAX_TEXT) return { ok: false, error: `text is longer than ${MAX_TEXT} characters` };
    let roId = null;
    if (b.ro_id != null && b.ro_id !== '') {
      if (typeof b.ro_id !== 'string' || !UUID_RE.test(b.ro_id)) return { ok: false, error: 'ro_id must be a uuid or empty' };
      roId = b.ro_id;
    }
    return { ok: true, action, kind: b.kind, text, roId };
  }

  if (action === 'clear' || action === 'undo') {
    if (typeof b.id !== 'string' || !UUID_RE.test(b.id)) return { ok: false, error: 'id must be a uuid' };
    if (action === 'undo') return { ok: true, action, id: b.id };
    if (b.reason !== 'erased' && b.reason !== 'arrived') return { ok: false, error: 'reason must be erased or arrived' };
    return { ok: true, action, id: b.id, reason: b.reason };
  }

  // called / uncalled
  if (typeof b.ro_id !== 'string' || !UUID_RE.test(b.ro_id)) return { ok: false, error: 'ro_id must be a uuid' };
  return { ok: true, action, roId: b.ro_id };
}

/* ── The handler ─────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // GATE — before the body is looked at.
  const employee = await requireUser(req);
  if (!employee) return res.status(401).json({ error: 'unauthorized' });

  const parsed = parseBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const env = process.env;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[whiteboard] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const db = { base: env.SUPABASE_URL || PROD_SUPABASE, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
  const who = { id: employee.id, name: String(employee.name || '').trim() || 'Someone' };
  const now = new Date().toISOString();

  try {
    switch (parsed.action) {
      case 'add': return await doAdd(res, db, parsed, who);
      case 'clear': return await doClear(res, db, parsed, who, now);
      case 'undo': return await doUndo(res, db, parsed);
      case 'called': return await doCalled(res, db, parsed, who, now);
      default: return await doUncalled(res, db, parsed, now);
    }
  } catch (e) {
    console.error('[whiteboard]', parsed.action, 'threw:', String((e && e.message) || e));
    return res.status(502).json({ error: 'write failed' });
  }
}

async function readOne(db, path) {
  const r = await fetch(`${db.base}/rest/v1/${path}`, { headers: db.headers });
  if (!r.ok) { console.error('[whiteboard] read failed · HTTP', r.status); return { error: true }; }
  const rows = await r.json();
  return { row: Array.isArray(rows) ? rows[0] || null : null };
}

async function write(db, method, path, body, extraPrefer) {
  const r = await fetch(`${db.base}/rest/v1/${path}`, {
    method,
    headers: { ...db.headers, Prefer: ['return=representation', extraPrefer].filter(Boolean).join(',') },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('[whiteboard] write failed · HTTP', r.status); return { ok: false }; }
  const rows = await r.json();
  return { ok: true, row: Array.isArray(rows) ? rows[0] || null : rows };   // row null = nothing matched
}

async function doAdd(res, db, p, who) {
  if (p.roId) {
    const ro = await readOne(db, `repair_orders?id=eq.${p.roId}&select=id`);
    if (ro.error) return res.status(502).json({ error: 'read failed' });
    if (!ro.row) return res.status(404).json({ error: 'ro not found' });
  }
  const w = await write(db, 'POST', `whiteboard_items?select=${ITEM_COLS}`, {
    kind: p.kind, text: p.text, ro_id: p.roId, created_by: who.id, created_by_name: who.name,
  });
  if (!w.ok || !w.row) return res.status(502).json({ error: 'write failed' });
  return res.status(200).json({ item: w.row });
}

async function doClear(res, db, p, who, now) {
  const cur = await readOne(db, `whiteboard_items?id=eq.${p.id}&select=id,kind,cleared_at`);
  if (cur.error) return res.status(502).json({ error: 'read failed' });
  if (!cur.row) return res.status(404).json({ error: 'item not found' });
  if (p.reason === 'arrived' && cur.row.kind !== 'parts') return res.status(400).json({ error: 'only a parts line can be marked arrived' });
  if (cur.row.cleared_at) return res.status(409).json({ error: 'already_cleared', message: 'Someone already took that line off the board.' });
  const w = await write(db, 'PATCH', `whiteboard_items?id=eq.${p.id}&cleared_at=is.null&select=${ITEM_COLS}`, {
    cleared_at: now, cleared_by: who.id, cleared_by_name: who.name, cleared_reason: p.reason,
  });
  if (!w.ok) return res.status(502).json({ error: 'write failed' });
  // Nothing matched = someone cleared it between the read and this write.
  if (!w.row) return res.status(409).json({ error: 'already_cleared', message: 'Someone already took that line off the board.' });
  return res.status(200).json({ item: w.row });
}

async function doUndo(res, db, p) {
  const cur = await readOne(db, `whiteboard_items?id=eq.${p.id}&select=id,cleared_at`);
  if (cur.error) return res.status(502).json({ error: 'read failed' });
  if (!cur.row) return res.status(404).json({ error: 'item not found' });
  if (!cur.row.cleared_at) return res.status(200).json({ item: cur.row, unchanged: true });
  const w = await write(db, 'PATCH', `whiteboard_items?id=eq.${p.id}&select=${ITEM_COLS}`, {
    cleared_at: null, cleared_by: null, cleared_by_name: null, cleared_reason: null,
  });
  if (!w.ok || !w.row) return res.status(502).json({ error: 'write failed' });
  return res.status(200).json({ item: w.row });
}

async function doCalled(res, db, p, who, now) {
  const ro = await readOne(db, `repair_orders?id=eq.${p.roId}&select=id,status`);
  if (ro.error) return res.status(502).json({ error: 'read failed' });
  if (!ro.row) return res.status(404).json({ error: 'ro not found' });
  if (ro.row.status !== 'invoice') return res.status(409).json({ error: 'not_ready', message: "That RO isn't ready for pickup any more." });
  const w = await write(db, 'POST', `whiteboard_pickup_calls?on_conflict=ro_id&select=${CALL_COLS}`, {
    ro_id: p.roId, called_at: now, called_by: who.id, called_by_name: who.name, updated_at: now,
  }, 'resolution=merge-duplicates');
  if (!w.ok || !w.row) return res.status(502).json({ error: 'write failed' });
  return res.status(200).json({ call: w.row });
}

async function doUncalled(res, db, p, now) {
  const w = await write(db, 'PATCH', `whiteboard_pickup_calls?ro_id=eq.${p.roId}&select=${CALL_COLS}`, {
    called_at: null, called_by: null, called_by_name: null, updated_at: now,
  });
  if (!w.ok) return res.status(502).json({ error: 'write failed' });
  // No row = it was never called: nothing to undo.
  return res.status(200).json({ call: w.row || { ro_id: p.roId, called_at: null, called_by: null, called_by_name: null } });
}
