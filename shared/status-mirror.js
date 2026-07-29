/* ============================================================
   status-mirror.js — mirror the shop-floor WORK-status dropdown onto the RO.

   The physical/work status lives on the FLOOR row (shopboard_lifts /
   shopboard_parking .status) — the SAME column v1 shop-board.html and gm-board's
   Shop Floor tab write. This module mirrors that ONE column so the CrisData RO
   detail can set it too; repair_orders gets NO work-status column (its own
   `status` is the money enum — untouched here).

   RAW status only. The derived six-state labels (Diagnosing / Awaiting Approval
   / In Progress / Complete) come from `status` PLUS *_at stamps that my-numbers
   owns — this module writes ONLY the raw `status` column and NEVER a *_at stamp,
   exactly like the shop-floor dropdowns.

   shopboard_pickup has NO status column: pickup membership IS the terminal
   "ready for pickup" state, so a car there is reported non-writable, not errored.

   No DOM. Loaded in the browser as an ES module that assigns window.StatusMirror
   and imported directly by shared/status-mirror.test.js.
   ============================================================ */

// CANONICAL option list — copied VERBATIM from shop-board.html:619 /
// gm-board.html:2715 (identical in both). Do not reorder or invent values;
// Kevin sees the exact control he already knows.
export const STATUS_OPTIONS = [
  { value: 'empty',           label: '- Unassigned -' },
  { value: 'in-progress',     label: 'In Progress' },
  { value: 'waiting-part',    label: 'Waiting for Part' },
  { value: 'waiting-tech',    label: 'Waiting for Tech' },
  { value: 'waiting-pull',    label: 'Waiting Pull' },
  { value: 'waiting-install', label: 'Waiting Install' },
  { value: 'waiting-quote',   label: 'Waiting Quote' },
  { value: 'waiting-auth',    label: 'Waiting Auth' },
  { value: 'qc',              label: 'QC' },
  { value: 'delayed',         label: 'Delayed' },
  { value: 'done',            label: 'Done / Ready' },
];

// Tables carrying a `status` column, plus pickup which does NOT. Order matters
// only for first-match; a given po is on at most one.
export const STATUS_FLOOR_TABLES = ['shopboard_parking', 'shopboard_lifts'];
export const PICKUP_TABLE = 'shopboard_pickup';

// Build the <option> data. Renders the canonical list verbatim and marks the
// current value selected. If the row holds a value NOT in the canonical list
// (e.g. 'approved', written by the advisor approval flow), it is appended at the
// END and selected — so the select reflects reality without reordering or
// dropping the real value. Choosing a canonical value then overwrites it.
export function buildStatusOptions(currentStatus) {
  const cur = currentStatus == null ? '' : String(currentStatus);
  const opts = STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, selected: o.value === cur }));
  if (cur && !STATUS_OPTIONS.some((o) => o.value === cur)) {
    opts.push({ value: cur, label: cur, selected: true });
  }
  return opts;
}

// Locate the car's floor row by po. Checks parking + lifts (which have status)
// and pickup (which does not — select only id there, to avoid a 42703). Returns
// { table, id, status, isPickup } or null when the car isn't on the floor.
export async function findStatusFloorRow(db, po) {
  const key = String(po == null ? '' : po);
  if (!key) return null;
  for (const table of STATUS_FLOOR_TABLES) {
    const { data, error } = await db.from(table).select('id,status').eq('po', key).limit(1);
    if (error) throw error;
    if (data && data.length) return { table, id: data[0].id, status: data[0].status ?? null, isPickup: false };
  }
  // pickup last — no status column, so select only id.
  const { data, error } = await db.from(PICKUP_TABLE).select('id').eq('po', key).limit(1);
  if (error) throw error;
  if (data && data.length) return { table: PICKUP_TABLE, id: data[0].id, status: null, isPickup: true };
  return null;
}

// Write the chosen status to the car's floor row (resolved fresh by po). Writes
// ONLY { status } — never a *_at stamp, never warranty, never repair_orders —
// and NEVER creates a floor row. Returns:
//   { ok:true, table, id, status }        on a lifts/parking write
//   { ok:false, reason:'pickup' }          car is on pickup (no status column)
//   { ok:false, reason:'no-floor-row' }    car isn't on the floor
//   { ok:false, error }                    a DB error
export async function mirrorStatus(db, po, statusValue) {
  const floor = await findStatusFloorRow(db, po);
  if (!floor) return { ok: false, reason: 'no-floor-row' };
  if (floor.isPickup) return { ok: false, reason: 'pickup' };
  const { error } = await db.from(floor.table).update({ status: statusValue }).eq('id', floor.id);
  if (error) return { ok: false, error };
  return { ok: true, table: floor.table, id: floor.id, status: statusValue };
}
