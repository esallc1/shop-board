/* ============================================================
   ro-writer.js — pure helpers for the RO's stored SERVICE WRITER.

   The service writer is WHO wrote the RO, stored as an employee ID on
   repair_orders.service_writer_id (migration 20260729_ro_service_writer.sql).
   These helpers are the single, TESTED source of truth for:
     • which employees may be a writer (role/active filter),
     • building the writer dropdown options (stores the ID, never the name),
     • resolving the printed "Service Advisor" name from the STORED writer
       (NEVER from the logged-in user — a blank is honest, a wrong name is not),
     • stamping the writer onto a new RO row at creation,
     • detecting the pre-migration "column missing" error so the board can run
       with the feature dormant.

   Loaded in the browser as an ES module that assigns window.RoWriter (see
   advisor-board.html), and imported directly by shared/ro-writer.test.js under
   `node --test`. It touches NO DOM and NO globals — that is the whole point:
   serviceWriterName() cannot accidentally read CHAT_IDENTITY because it has no
   access to it.
   ============================================================ */

// Roles allowed to be an RO's service writer. NOTE the advisor role value is
// 'advisor' (the label is "Service Advisor"), NOT 'service_advisor'. 'tech' and
// 'bookkeeping' are intentionally excluded.
export const WRITER_ROLES = ['advisor', 'manager', 'owner'];

// An employee may be a writer only if they are ACTIVE and hold a writer role.
export function isEligibleWriter(emp) {
  return !!emp && emp.active === true && WRITER_ROLES.includes(emp.role);
}

// Build the <option> data for the Service Writer dropdown. Filters `rows` to
// eligible writers (defensive — the DB query also filters), maps each to
// { id, name, selected } keyed on the employee ID (never the name), and marks
// the currently-stored writer selected. If the stored writer is no longer
// eligible (e.g. deactivated or role changed) it is still shown + selected so
// editing the RO never silently drops the recorded author.
export function buildWriterOptions(rows, selectedId, selectedName) {
  const sel = selectedId == null ? '' : String(selectedId);
  const opts = (rows || []).filter(isEligibleWriter).map((e) => ({
    id: String(e.id),
    name: e.name,
    selected: String(e.id) === sel,
  }));
  if (sel && !opts.some((o) => o.selected)) {
    opts.push({ id: sel, name: selectedName || '(unknown)', selected: true });
  }
  return opts;
}

// Resolve the name printed on the "Service Advisor" line from the RO's STORED
// writer embed (repair_orders → employees). Returns '—' when there is no stored
// writer (the ~30 pre-tracking ROs, or a board running before the migration).
// Deliberately reads ONLY the RO — never the logged-in user — so printing an RO
// as a different person still shows the RO's real writer.
export function serviceWriterName(ro) {
  const w = ro && ro.service_writer;
  const row = Array.isArray(w) ? w[0] : w;   // to-one embed is an object; be defensive
  return (row && row.name) || '—';
}

// Stamp the writer onto a new RO insert row. employeeId is the creator's
// employee ID (CURRENT_EMPLOYEE_ID); a falsy id stores NULL rather than blocking
// creation. Never throws, never mutates the input.
export function withServiceWriter(row, employeeId) {
  return { ...row, service_writer_id: employeeId || null };
}

// True when a PostgREST error means the column/relationship isn't there yet
// (migration not applied). 42703 = Postgres "column does not exist"; PGRST204 =
// PostgREST "Could not find the '<col>' column in the schema cache" (what a
// write to a not-yet-migrated column returns). Matches advisor-board's inline
// isMissingColumn so both sides of the fallback agree.
export function isMissingColumn(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg = err.message || '';
  return code === '42703' || code === 'PGRST204' ||
    /column .* does not exist/i.test(msg) ||
    /could not find the .* column/i.test(msg);
}
