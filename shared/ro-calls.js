/* ============================================================
   ro-calls.js — pure helpers for showing a customer's calls on the RO and for
   the "Checking on their car" RO picker.

   Two consumers, both in advisor-board.html:
     • the RO detail Call-History section — sorts calls newest-first,
     • the ring-time card's checking_on_car picker — offers ALL of the
       customer's ROs, ordered (active work first) and labelled with their stage
       so a closed RO is never presented as current work.

   No DOM, no db. Loaded in the browser as an ES module that assigns
   window.RoCalls, and imported directly by shared/ro-calls.test.js.
   ============================================================ */

// Human stage label for an RO option / row.
export function roStageLabel(ro) {
  if (!ro) return '';
  switch (ro.status) {
    case 'ro':       return 'Active RO';
    case 'estimate': return ro.declined_at ? 'Declined estimate' : 'Estimate';
    case 'invoice':  return 'Invoice';
    case 'closed':   return 'Closed';
    default:         return ro.status || '';
  }
}

// Picker group order: active work first (a current RO, then a live estimate),
// then finished-but-not-collected (invoice), then closed jobs, then declined
// estimates (dead quotes) last. Lower rank = higher in the list.
export function roPickerRank(ro) {
  const s = ro && ro.status, declined = !!(ro && ro.declined_at);
  if (s === 'ro') return 0;
  if (s === 'estimate' && !declined) return 1;
  if (s === 'invoice') return 2;
  if (s === 'closed') return 3;
  if (s === 'estimate' && declined) return 4;
  return 5;   // unknown status → last
}

// Sort ROs for the picker: by group rank, then newest-first (created_at desc)
// within each group. Pure (does not mutate the input).
export function sortRosForPicker(ros) {
  return [...(ros || [])].sort((a, b) => {
    const ra = roPickerRank(a), rb = roPickerRank(b);
    if (ra !== rb) return ra - rb;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
}

// Build the <option> data: sorted, each labelled "#<ro_number> · <stage>", with
// the current selection marked. Stores the RO id (string) as the value.
export function buildRoPickerOptions(ros, selectedId) {
  const sel = selectedId == null ? '' : String(selectedId);
  return sortRosForPicker(ros).map((r) => ({
    id: String(r.id),
    ro_number: r.ro_number,
    label: `#${r.ro_number == null ? '?' : r.ro_number} · ${roStageLabel(r)}`,
    selected: String(r.id) === sel,
  }));
}

// Order the calls linked to an RO newest-first — by when the call came in
// (started_at), falling back to when it was noted (noted_at). Pure.
export function sortCallsNewestFirst(calls) {
  return [...(calls || [])].sort((a, b) => {
    const ta = (a && (a.started_at || a.noted_at)) || '';
    const tb = (b && (b.started_at || b.noted_at)) || '';
    return String(tb).localeCompare(String(ta));
  });
}
