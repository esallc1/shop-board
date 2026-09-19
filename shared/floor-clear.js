/* ============================================================
   floor-clear.js — CLOSING AN RO TAKES ITS CAR OFF THE SHOP FLOOR.

   The shop closes an RO only after the car has left the lot (Cris, 2026-09-19),
   so "closed" means "gone". Before this module, only the Off-lot button removed
   the car's floor row; closing from the RO detail's Stage dropdown left it, and
   the Tech Board / Approval Queue / Tech Status kept showing cars that had left
   weeks ago (Kevin, Aug 6 / 13 / 26). Now there is ONE close path — the board's
   setStage('closed') — and it calls prepareClose() below BEFORE it writes the
   RO status. Off lot just calls that same close step.

   The order is the whole point:
     1. ask (unless the caller already asked — Off lot has its own confirm)
     2. remove the car from the floor
     3. only if that worked, the caller writes status = 'closed' + archives.
   A cancel changes nothing; a floor failure leaves the RO unclosed and
   retryable (removal is idempotent, so a retry is always safe).

   Floor shape (the v1 floor, three tables, matched by po):
     • shopboard_parking / shopboard_pickup — one dynamic row per car → DELETE.
     • shopboard_lifts — 6 FIXED bays → NEVER deleted; the bay is CLEARED back to
       EMPTY_LIFT (the same row shape v1 writes when a bay empties).

   No DOM. Loaded in the browser as an ES module that assigns window.FloorClear
   and imported directly by shared/floor-clear.test.js.
   See docs/wiring/ro-checkin-tech.md §8 and tech-board.md §8.
   ============================================================ */

// An emptied lift bay — the exact row shape v1 (shop-board.html) wrote when it
// cleared a bay, and what Off lot has written since it was built. Moved here
// verbatim from advisor-board.html so the one close path owns it.
export const EMPTY_LIFT = Object.freeze({
  po: '', vehicle: '', customer: '', work: '', status: 'empty', notes: '',
  arrival_date: null, assigned_tech: '', tech_status: 'available',
  tech_notes: '', job_category: '', warranty: false,
});

export const CLOSE_CONFIRM_TEXT = 'This also removes the car from the shop floor.';

// Remove a car from the floor wherever it sits, by po. Parking + pickup rows are
// deleted; a lift bay is cleared to EMPTY_LIFT (never deleted). Idempotent: a po
// that matches nothing is a no-op success. Stops at the first error.
// → { ok: true, removed: { parking, pickup, lifts } } | { ok: false, error }
export async function removeCarFromFloor(db, po) {
  const key = String(po == null ? '' : po).trim();
  if (!key) return { ok: true, removed: { parking: 0, pickup: 0, lifts: 0 } };   // nothing to match
  const removed = { parking: 0, pickup: 0, lifts: 0 };

  const dp = await db.from('shopboard_parking').delete().eq('po', key).select('id');
  if (dp.error) return { ok: false, error: dp.error };
  removed.parking = (dp.data || []).length;

  const dk = await db.from('shopboard_pickup').delete().eq('po', key).select('id');
  if (dk.error) return { ok: false, error: dk.error };
  removed.pickup = (dk.data || []).length;

  const { data: lifts, error: lErr } = await db.from('shopboard_lifts').select('id').eq('po', key);
  if (lErr) return { ok: false, error: lErr };
  for (const l of (lifts || [])) {
    const { error } = await db.from('shopboard_lifts').update({ ...EMPTY_LIFT }).eq('id', l.id);
    if (error) return { ok: false, error };
    removed.lifts++;
  }
  return { ok: true, removed };
}

// The floor half of a close, run by setStage('closed') AFTER its comeback and
// book-hours checks and BEFORE it writes the status.
//   alreadyConfirmed — the caller asked the user already (Off lot) → don't ask twice
//   confirm()        — () => boolean; the Stage dropdown's "also removes the car" ask
//   removeFloor()    — () => Promise<{ ok, error? }>; the floor removal
// → { ok: true } → the caller may write status = 'closed'
//   { ok: false, reason: 'cancelled' }        → nothing was touched
//   { ok: false, reason: 'floor', error }     → nothing written to the RO; retryable
export async function prepareClose({ alreadyConfirmed, confirm, removeFloor }) {
  if (!alreadyConfirmed) {
    const yes = typeof confirm === 'function' ? !!confirm() : false;
    if (!yes) return { ok: false, reason: 'cancelled' };
  }
  let res;
  try { res = await removeFloor(); }
  catch (error) { return { ok: false, reason: 'floor', error }; }
  if (!res || !res.ok) return { ok: false, reason: 'floor', error: res && res.error };
  return { ok: true, removed: res.removed };
}
