/* ============================================================
   warranty-mirror.js — the "Warranty / Comeback" floor-mirror decision.

   The warranty/comeback flag is a boolean on the FLOOR rows
   (shopboard_lifts / shopboard_parking / shopboard_pickup) — the SAME column
   shop-board.html (v1) and gm-board's Shop Floor tab write, and gm-board's
   Comebacks tab reads. The CrisData RO detail mirrors into that same column so
   the fact lives in ONE place; repair_orders gets NO warranty column.

   This module holds the single, TESTED decision for what to write when the
   toggle flips, matching gm-board's sfWarrantyStampPayload:
     • ON  → warranty=true AND stamp comeback_flagged_at — ONCE. An existing
             stamp is reused (idempotent double-fire, and re-toggling ON never
             moves the historical date the Overview comeback-rate metric feeds on).
     • OFF → warranty=false ONLY. comeback_flagged_at is NEVER touched, so
             un-toggling can never erase the historical comeback stamp.

   No DOM, no db. Loaded in the browser as an ES module that assigns
   window.WarrantyMirror, and imported directly by shared/warranty-mirror.test.js.
   ============================================================ */

// A car may sit on any of the three floor tables; resolve by po across all.
export const FLOOR_TABLES = ['shopboard_parking', 'shopboard_lifts', 'shopboard_pickup'];

// Build the floor-row patch for a warranty toggle.
//   currentComebackFlaggedAt — the row's existing comeback_flagged_at (or null)
//   on                       — the new toggle state
//   nowIso                   — timestamp to stamp when first turning ON
// Returns { warranty } on OFF, or { warranty, comeback_flagged_at } on ON.
export function warrantyStampPayload(currentComebackFlaggedAt, on, nowIso) {
  const payload = { warranty: !!on };
  if (on) {
    // Stamp once; reuse any existing stamp rather than gating on its absence so
    // a checkbox's paired input+change fire in one tick agree on one value, and
    // a later re-ON never rewrites the original date.
    payload.comeback_flagged_at = currentComebackFlaggedAt || nowIso;
  }
  // OFF: deliberately omit comeback_flagged_at — the historical stamp survives.
  return payload;
}

// Locate the car's live floor row by po across the three tables. `db` is a
// supabase-js-shaped client. Returns { table, id, warranty, comeback_flagged_at }
// or null when the car isn't on the floor. Reads ONLY the floor tables.
export async function findFloorRow(db, po) {
  const key = String(po == null ? '' : po);
  if (!key) return null;
  for (const table of FLOOR_TABLES) {
    const { data, error } = await db.from(table)
      .select('id,warranty,comeback_flagged_at').eq('po', key).limit(1);
    if (error) throw error;
    if (data && data.length) {
      return { table, id: data[0].id, warranty: !!data[0].warranty, comeback_flagged_at: data[0].comeback_flagged_at };
    }
  }
  return null;
}

// Mirror a warranty toggle onto the car's floor row (resolved fresh by po).
// Writes ONLY the floor table — never repair_orders — and NEVER creates a floor
// row: a car with no floor row returns { ok:false, reason:'no-floor-row' } and
// nothing is written. On success returns the table/id/payload written and the
// updated floor snapshot. `nowIso` is injectable for deterministic testing.
export async function mirrorWarranty(db, po, on, nowIso) {
  const floor = await findFloorRow(db, po);
  if (!floor) return { ok: false, reason: 'no-floor-row' };
  const payload = warrantyStampPayload(floor.comeback_flagged_at, on, nowIso || new Date().toISOString());
  const { error } = await db.from(floor.table).update(payload).eq('id', floor.id);
  if (error) return { ok: false, error };
  return {
    ok: true,
    table: floor.table,
    id: floor.id,
    payload,
    floor: { ...floor, warranty: !!on, comeback_flagged_at: payload.comeback_flagged_at ?? floor.comeback_flagged_at },
  };
}
