/* ============================================================
   api/desk-appointment.js — create a MANUAL Desk appointment (a walk-in or any
   scheduled drop-off/callback that never came in as a call).

   POST { next_step, due_at, due_all_day, caller_bare, caller_formatted, cnam,
          customer_id, note, noted_by_name }
     → inserts one `calls` row and returns { appointment: { id, ... } }.

   ── WHY A SERVER ENDPOINT IS REQUIRED (not optional) ──
   `calls` is RLS anon-SELECT + anon-UPDATE only — there is NO anon INSERT policy
   (row creation was deliberately kept service-role/webhook-only so every row
   maps to a real CTM call). A manual appointment is the ONE legitimate non-call
   insert, so it runs here with the service-role key, same posture as
   api/recording-assign.js.

   ── THE WALK-IN REPRESENTATION (single-row model, see call-window-desk.md) ──
   The appointment IS a `calls` row — there is no separate table. A manual add is
   marked as "not a real call" by:
     • ctm_call_id = a SYNTHETIC NEGATIVE id (real CTM ids are positive), so it
       never collides with a webhook row and is trivially identifiable.
     • started_at = null → it never shows up in the day's Call Log (which queries
       by started_at); it only lives on the Desk via next_step + due_at.
   next_step is limited to the two Desk-lane steps; resolved_at stays null (it's
   an open item on the Desk until someone marks it done).
   ============================================================ */

const SUPABASE_URL = 'https://hygemiszxwmyrkmhbjub.supabase.co';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The two steps that land on a Desk lane. checking_on_car / price_shopper are
// not schedulable appointments, so a manual add can't create them.
export const APPT_STEPS = ['quoted_callback', 'dropping_off'];

// Validate + normalize the body to exactly the columns we insert. Pure +
// exported so the input contract is locked by a test. Requires a real identity
// (a 10-digit phone OR a customer_id) and a valid future-or-any due_at.
export function parseApptBody(body) {
  const b = body || {};
  if (!APPT_STEPS.includes(b.next_step)) {
    return { ok: false, error: 'next_step must be quoted_callback or dropping_off' };
  }
  if (typeof b.due_at !== 'string' || Number.isNaN(Date.parse(b.due_at))) {
    return { ok: false, error: 'due_at must be an ISO timestamp' };
  }
  const due_all_day = b.due_all_day !== false;   // default true; only an explicit false is a timed slot
  const caller_bare = String(b.caller_bare == null ? '' : b.caller_bare).replace(/\D/g, '');
  const customer_id = b.customer_id == null ? null : String(b.customer_id);
  if (customer_id !== null && !UUID_RE.test(customer_id)) {
    return { ok: false, error: 'customer_id must be a uuid or null' };
  }
  if (caller_bare.length !== 10 && customer_id === null) {
    return { ok: false, error: 'a 10-digit phone or a customer is required' };
  }
  const trim = (v, n) => (v == null ? null : String(v).slice(0, n) || null);
  return {
    ok: true,
    row: {
      next_step: b.next_step,
      due_at: b.due_at,
      due_all_day,
      caller_bare: caller_bare.length === 10 ? caller_bare : null,
      caller_formatted: trim(b.caller_formatted, 40),
      cnam: trim(b.cnam, 120),
      note: trim(b.note, 2000),
      customer_id,
      noted_by_name: trim(b.noted_by_name, 120),
    },
  };
}

// A synthetic, negative ctm_call_id for a manual row. Real CTM ids are positive,
// so negative can never collide with a webhook insert. ms*1000 + a sub-ms random
// component keeps two near-simultaneous manual adds distinct, and stays well
// inside int8 range. Pure + exported so the "always negative" invariant is tested.
export function syntheticCtmId(nowMs, rnd) {
  const base = Math.floor(nowMs) * 1000 + Math.floor((rnd || 0) * 1000);
  return -base;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = parseApptBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[desk-appointment] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const headers = {
    apikey: key, Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  };

  const row = {
    ...parsed.row,
    started_at: null,                          // NOT a real call → stays out of the Call Log
    noted_at: new Date().toISOString(),
  };

  // Insert with a synthetic ctm_call_id; on the astronomically unlikely UNIQUE
  // collision (409), regenerate once and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    row.ctm_call_id = syntheticCtmId(Date.now(), Math.random());
    let r;
    try {
      r = await fetch(`${SUPABASE_URL}/rest/v1/calls?select=id,next_step,due_at,due_all_day,customer_id,caller_bare,caller_formatted`, {
        method: 'POST', headers, body: JSON.stringify(row),
      });
    } catch (e) {
      console.error('[desk-appointment] insert threw', e);
      return res.status(502).json({ error: 'insert failed' });
    }
    if (r.ok) {
      const j = await r.json();
      return res.status(200).json({ appointment: (j && j[0]) || null });
    }
    if (r.status === 409 && attempt === 0) continue;   // ctm_call_id collision → retry
    console.error('[desk-appointment] insert failed', r.status, await r.text());
    return res.status(502).json({ error: 'insert failed' });
  }
}
