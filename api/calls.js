/* ============================================================
   api/calls.js — the server-side writer for the `calls` table (security
   slice 3). Wiring: docs/wiring/call-window-desk.md §5a, inbox-calls.md §5.

   WHY: the advisor board used to UPDATE `calls` straight from the browser with
   the public key (anon / authenticated UPDATE `using (true)`), so anyone with
   the key could rewrite any call. Every browser write moves here, then the
   UPDATE policies are dropped (step (b), a separate migration Cris runs).

   Step (a)1 (2026-09-25) moves the TRAY CALL CARD's three writers:
     note          — the card's note / next step / date / key box / filed RO,
                     plus (optionally) the single-match customer the card
                     already knows (fold_customer_id — only fills an EMPTY
                     customer_id, never replaces one a person set);
     customer      — a person picked the customer (multi-match on the number);
     auto_file_ro  — the robot's open-RO check after a human attach: exactly
                     one RO open when the call came in → file it, and ONLY into
                     an empty ro_id (shared/call-auto-attach.js rules).
   The other 12 browser writers (Desk, Call Log, customer record) still write
   directly until steps (a)2 / (a)3.

   GATE — requireUser(req) FIRST: a live Supabase session that maps to an
   ACTIVE employee (the same rule as public.is_staff()). A KiKi login, an
   inactive employee, or no token → 401 before the body is even read.

   RULES (each locked by api/calls.test.js):
     • each action writes ONLY its own columns; any other key in the body is
       refused (400), so a caller can never set noted_by_name, resolved_at, …;
     • who + when are stamped HERE: noted_at / noted_by_name come from the
       signed-in employee and the server clock, and noted_at is stamped ONCE
       (a conditional PATCH `noted_at=is.null`) — a later save never moves it;
     • a person touching ro_id clears the robot's run tags (clearAutoFileTagsPatch);
     • the robot's RO fill is conditional on `ro_id=is.null` in the SAME write,
       so it can never overwrite a person's choice, whatever the order;
     • the response is the row as the database now has it — the card shows
       "Saved ✓" only on a 200.
   Writes with the service-role key (RLS bypassed, like api/whiteboard.js).
   ============================================================ */
import { requireUser } from './_lib/require-user.js';
import { pickOpenRoAt, autoFileRoPatch, clearAutoFileTagsPatch } from '../shared/call-auto-attach.js';

const PROD_SUPABASE = 'https://hygemiszxwmyrkmhbjub.supabase.co';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTIONS = ['note', 'customer', 'auto_file_ro'];
export const NEXT_STEPS = ['quoted_callback', 'dropping_off', 'checking_on_car', 'price_shopper'];
export const MAX_NOTE = 10000;
// What the card may set with `note`. Nothing else — never a stamp, never resolved_at.
export const NOTE_FIELDS = ['note', 'next_step', 'due_at', 'due_all_day', 'ro_id', 'dropoff_key_box'];
// What the response carries back (the card's view of the row).
export const CALL_COLS = 'id,customer_id,ro_id,note,next_step,due_at,due_all_day,dropoff_key_box,noted_at,noted_by_name,started_at,auto_attached_at,auto_ro_filed_at,auto_attach_run_id';

const isCallId = (v) => Number.isInteger(v) && v > 0;

// Validate + normalize the body. Pure + exported so the contract is test-locked.
export function parseBody(body) {
  const b = body && typeof body === 'object' ? body : null;
  if (!b) return { ok: false, error: 'body must be a JSON object' };
  if (!ACTIONS.includes(b.action)) return { ok: false, error: `action must be one of ${ACTIONS.join(', ')}` };
  const callId = Number(b.call_id);
  if (!isCallId(callId)) return { ok: false, error: 'call_id must be a positive integer' };
  const allowedTop = { note: ['action', 'call_id', 'fields', 'fold_customer_id'], customer: ['action', 'call_id', 'customer_id'], auto_file_ro: ['action', 'call_id'] }[b.action];
  const extra = Object.keys(b).filter((k) => !allowedTop.includes(k));
  if (extra.length) return { ok: false, error: `not allowed: ${extra.join(', ')}` };

  if (b.action === 'customer') {
    if (typeof b.customer_id !== 'string' || !UUID_RE.test(b.customer_id)) return { ok: false, error: 'customer_id must be a uuid' };
    return { ok: true, action: 'customer', callId, customerId: b.customer_id };
  }
  if (b.action === 'auto_file_ro') return { ok: true, action: 'auto_file_ro', callId };

  // note
  const f = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? b.fields : null;
  if (!f) return { ok: false, error: 'fields must be an object' };
  const keys = Object.keys(f);
  if (!keys.length) return { ok: false, error: 'fields is empty' };
  const bad = keys.filter((k) => !NOTE_FIELDS.includes(k));
  if (bad.length) return { ok: false, error: `field not allowed: ${bad.join(', ')}` };
  const out = {};
  if ('note' in f) {
    if (f.note !== null && typeof f.note !== 'string') return { ok: false, error: 'note must be text or null' };
    if (typeof f.note === 'string' && f.note.length > MAX_NOTE) return { ok: false, error: `note is longer than ${MAX_NOTE} characters` };
    out.note = f.note;
  }
  if ('next_step' in f) {
    if (f.next_step !== null && !NEXT_STEPS.includes(f.next_step)) return { ok: false, error: 'next_step is not a known step' };
    out.next_step = f.next_step;
  }
  if ('due_at' in f) {
    if (f.due_at !== null && (typeof f.due_at !== 'string' || Number.isNaN(Date.parse(f.due_at)))) return { ok: false, error: 'due_at must be an ISO timestamp or null' };
    out.due_at = f.due_at;
  }
  if ('due_all_day' in f) {
    if (typeof f.due_all_day !== 'boolean') return { ok: false, error: 'due_all_day must be true or false' };
    out.due_all_day = f.due_all_day;
  }
  if ('dropoff_key_box' in f) {
    if (typeof f.dropoff_key_box !== 'boolean') return { ok: false, error: 'dropoff_key_box must be true or false' };
    out.dropoff_key_box = f.dropoff_key_box;
  }
  if ('ro_id' in f) {
    if (f.ro_id !== null && (typeof f.ro_id !== 'string' || !UUID_RE.test(f.ro_id))) return { ok: false, error: 'ro_id must be a uuid or null' };
    out.ro_id = f.ro_id;
  }
  let fold = null;
  if (b.fold_customer_id != null) {
    if (typeof b.fold_customer_id !== 'string' || !UUID_RE.test(b.fold_customer_id)) return { ok: false, error: 'fold_customer_id must be a uuid' };
    fold = b.fold_customer_id;
  }
  return { ok: true, action: 'note', callId, fields: out, foldCustomerId: fold };
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
    console.error('[calls] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const db = { base: env.SUPABASE_URL || PROD_SUPABASE, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
  const who = { id: employee.id, name: String(employee.name || '').trim() || null };
  const now = new Date().toISOString();

  try {
    const cur = await readOne(db, `calls?id=eq.${parsed.callId}&select=${CALL_COLS}`);
    if (cur.error) return res.status(502).json({ error: 'read failed' });
    if (!cur.row) return res.status(404).json({ error: 'call not found' });
    switch (parsed.action) {
      case 'note': return await doNote(res, db, parsed, cur.row, who, now);
      case 'customer': return await doCustomer(res, db, parsed, cur.row);
      default: return await doAutoFileRo(res, db, cur.row, now);
    }
  } catch (e) {
    console.error('[calls]', parsed.action, 'threw:', String((e && e.message) || e));
    return res.status(502).json({ error: 'write failed' });
  }
}

async function readOne(db, path) {
  const r = await fetch(`${db.base}/rest/v1/${path}`, { headers: db.headers });
  if (!r.ok) { console.error('[calls] read failed · HTTP', r.status); return { error: true }; }
  const rows = await r.json();
  return { row: Array.isArray(rows) ? rows[0] || null : null, rows: Array.isArray(rows) ? rows : [] };
}

// PATCH calls; `filter` adds guards (e.g. '&noted_at=is.null'). row null = nothing matched.
async function patchCall(db, id, filter, body) {
  const r = await fetch(`${db.base}/rest/v1/calls?id=eq.${id}${filter}&select=${CALL_COLS}`, {
    method: 'PATCH',
    headers: { ...db.headers, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('[calls] write failed · HTTP', r.status, await r.text().catch(() => '')); return { ok: false }; }
  const rows = await r.json();
  return { ok: true, row: Array.isArray(rows) ? rows[0] || null : rows };
}

async function customerExists(db, id) {
  const c = await readOne(db, `customers?id=eq.${id}&select=id`);
  return c.error ? null : !!c.row;
}

async function doNote(res, db, p, row, who, now) {
  const body = { ...p.fields };
  if ('ro_id' in body) {
    if (body.ro_id) {
      const ro = await readOne(db, `repair_orders?id=eq.${body.ro_id}&select=id`);
      if (ro.error) return res.status(502).json({ error: 'read failed' });
      if (!ro.row) return res.status(404).json({ error: 'ro not found' });
    }
    Object.assign(body, clearAutoFileTagsPatch());          // a person chose the RO → out of the robot's namespace
  }
  let latest = row;
  const w = await patchCall(db, p.callId, '', body);
  if (!w.ok) return res.status(502).json({ error: 'write failed' });
  if (w.row) latest = w.row;

  // noted_at is stamped ONCE, by the server, for the signed-in employee.
  if (!latest.noted_at) {
    const s = await patchCall(db, p.callId, '&noted_at=is.null', { noted_at: now, noted_by_name: who.name });
    if (!s.ok) return res.status(502).json({ error: 'write failed' });
    if (s.row) latest = s.row;
    else { const again = await readOne(db, `calls?id=eq.${p.callId}&select=${CALL_COLS}`); if (again.row) latest = again.row; }
  }

  // The card's single-match customer: only into an EMPTY customer_id.
  let folded = false;
  if (p.foldCustomerId && latest.customer_id == null) {
    const ok = await customerExists(db, p.foldCustomerId);
    if (ok === null) return res.status(502).json({ error: 'read failed' });
    if (ok) {
      const c = await patchCall(db, p.callId, '&customer_id=is.null', { customer_id: p.foldCustomerId });
      if (!c.ok) return res.status(502).json({ error: 'write failed' });
      if (c.row) { latest = c.row; folded = true; }
    }
  }
  return res.status(200).json({ call: latest, customer_folded: folded });
}

// A person picked who this is. No noted stamp (picking a name isn't noting the call).
async function doCustomer(res, db, p) {
  const ok = await customerExists(db, p.customerId);
  if (ok === null) return res.status(502).json({ error: 'read failed' });
  if (!ok) return res.status(404).json({ error: 'customer not found' });
  const w = await patchCall(db, p.callId, '', { customer_id: p.customerId });
  if (!w.ok || !w.row) return res.status(502).json({ error: 'write failed' });
  return res.status(200).json({ call: w.row });
}

// The robot: exactly one RO open when the call came in → file it, only into an empty ro_id.
async function doAutoFileRo(res, db, row, now) {
  if (row.ro_id != null || !row.customer_id || !row.started_at) return res.status(200).json({ call: row, ro_id: null });
  const ros = await readOne(db, `repair_orders?select=id,status,created_at,closed_at,declined_at&customer_id=eq.${encodeURIComponent(row.customer_id)}`);
  if (ros.error) return res.status(502).json({ error: 'read failed' });
  const roId = pickOpenRoAt(ros.rows, row.started_at);
  if (!roId) return res.status(200).json({ call: row, ro_id: null });          // 0 or 2+ open → never guess
  const w = await patchCall(db, row.id, '&ro_id=is.null', autoFileRoPatch(roId, now));
  if (!w.ok) return res.status(502).json({ error: 'write failed' });
  if (!w.row) return res.status(200).json({ call: row, ro_id: null });         // a person filed it first — fine
  return res.status(200).json({ call: w.row, ro_id: roId });
}
