/* ============================================================
   api/recording-assign.js — assign (or clear) a recording's vehicle.

   POST { call_id, vehicle_id }  (vehicle_id null = clear the assignment)
   → writes recordings.vehicle_id for the row matching that call, returns the
     new value: { call_id, vehicle_id }.

   ── WHY A SERVER ENDPOINT IS REQUIRED (not optional) ──
   The recordings table is RLS default-deny with ZERO policies, so the boards'
   anon key CANNOT write to it. This runs with the service-role key server-side
   ONLY, same posture as api/recording-links.js.

   ── SECURITY ──
   • IDS ONLY. We read call_id + vehicle_id and NOTHING else from the body — a
     storage_path / remote_url / any recording-row field in the payload is
     ignored. The row is located by call_id; the caller can't supply row fields.
   • OWNERSHIP is validated before any write: resolve the call's CONFIRMED
     customer (calls.customer_id), then require the target vehicle to belong to
     THAT customer (vehicles.customer_id). Mismatch → rejected. Without this the
     endpoint would let anyone link any recording to any vehicle.
   • A call with no confirmed customer_id is rejected — the PERSON link comes
     before the vehicle link (recordings deliberately has no customer_id).
   • NEVER returns remote_url / storage_path / last_error — the PATCH selects
     only call_id, vehicle_id back, so no sensitive field is even fetched.
   • Idempotent — re-assigning the same vehicle is a no-op success.
   ============================================================ */

const SUPABASE_URL = 'https://hygemiszxwmyrkmhbjub.supabase.co';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse + validate the body to IDS ONLY. Pure + exported so the ids-only
// contract is locked by a test. vehicle_id === null means "clear".
export function parseAssignBody(body) {
  const b = body || {};
  const n = Number(b.call_id);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'call_id must be a positive integer' };
  if (!('vehicle_id' in b)) return { ok: false, error: 'vehicle_id required (null to clear)' };
  const v = b.vehicle_id;
  if (v !== null) {
    if (typeof v !== 'string' || !UUID_RE.test(v)) return { ok: false, error: 'vehicle_id must be a uuid or null' };
  }
  return { ok: true, call_id: n, vehicle_id: v === null ? null : v };
}

// Does the vehicle belong to the call's confirmed customer? Pure + exported.
// A call with no confirmed customer can never pass (person link comes first).
export function ownershipOk(callCustomerId, vehicleCustomerId) {
  if (callCustomerId == null) return false;
  return String(vehicleCustomerId) === String(callCustomerId);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = parseAssignBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { call_id, vehicle_id } = parsed;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[recording-assign] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // 1. Resolve the call's CONFIRMED customer.
  let call;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/calls?id=eq.${call_id}&select=id,customer_id`, { headers });
    if (!r.ok) { console.error('[recording-assign] call lookup', r.status, await r.text()); return res.status(502).json({ error: 'call lookup failed' }); }
    call = (await r.json())[0];
  } catch (e) { console.error('[recording-assign] call lookup threw', e); return res.status(502).json({ error: 'call lookup failed' }); }
  if (!call) return res.status(404).json({ error: 'call not found' });
  if (!call.customer_id) return res.status(409).json({ error: 'call has no confirmed customer — attach it first' });

  // 2. If ASSIGNING (not clearing), the vehicle must belong to that customer.
  if (vehicle_id !== null) {
    let veh;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vehicles?id=eq.${vehicle_id}&select=id,customer_id`, { headers });
      if (!r.ok) { console.error('[recording-assign] vehicle lookup', r.status, await r.text()); return res.status(502).json({ error: 'vehicle lookup failed' }); }
      veh = (await r.json())[0];
    } catch (e) { console.error('[recording-assign] vehicle lookup threw', e); return res.status(502).json({ error: 'vehicle lookup failed' }); }
    if (!veh) return res.status(404).json({ error: 'vehicle not found' });
    if (!ownershipOk(call.customer_id, veh.customer_id)) return res.status(403).json({ error: 'vehicle does not belong to this customer' });
  }

  // 3. Write recordings.vehicle_id for the row matching this call. select back
  //    ONLY call_id,vehicle_id so no sensitive column is ever fetched or returned.
  let rows;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/recordings?call_id=eq.${call_id}&select=call_id,vehicle_id`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ vehicle_id, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) { console.error('[recording-assign] patch failed', r.status, await r.text()); return res.status(502).json({ error: 'write failed' }); }
    rows = await r.json();
  } catch (e) { console.error('[recording-assign] patch threw', e); return res.status(502).json({ error: 'write failed' }); }
  if (!rows || !rows.length) return res.status(404).json({ error: 'no recording for this call' });

  return res.status(200).json({ call_id, vehicle_id });
}
