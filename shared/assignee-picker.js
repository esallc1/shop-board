/* ============================================================
   assignee-picker.js — the WRITE-SAFETY rule for every "who is this
   assigned to?" dropdown, in one tested place.

   THE RULE: a picker must always contain whoever is CURRENTLY assigned,
   even when that person would no longer be offered.

   This is not a display preference. A <select> with no matching <option>
   does not render blank — it silently displays option[0]. The next person
   to open that row sees "Unassigned", saves something unrelated, and the
   assignment is gone. The control turns an ordinary save into a deletion,
   and nothing errors. Same failure family as every other bug this week:
   the broken state is indistinguishable from the healthy one.

   It bites whenever the roster and the assignment can disagree — which is
   NORMAL, not exceptional:
     • the assignee was retired (they keep every past assignment — see
       docs/wiring/employee-roster.md §6a),
     • the assignee's role isn't the one the picker filters on (an owner
       doing diag while short-staffed),
     • the name was typed before the roster was live (legacy floor rows).

   DOM-free and global-free on purpose: it returns plain option objects and
   the caller escapes + renders. That is what makes it unit-testable, and it
   is why the rule can live in ONE place instead of being re-derived per
   board. Callers: gm-board.html (Shop Floor lifts, Shop Floor parking,
   Teardown) and shared/ro-writer.js (service writer, id-based).

   Loaded in the browser as an ES module assigned to window.AssigneePicker
   (see gm-board.html), and imported directly by assignee-picker.test.js.
   ============================================================ */

// Values that mean "nobody", in the data as it actually exists: the floor
// tables carry BOTH '' and the literal string 'Unassigned' as sentinels.
export const UNASSIGNED_SENTINELS = ['', 'Unassigned'];

export function isUnassignedValue(v) {
  return UNASSIGNED_SENTINELS.indexOf(String(v == null ? '' : v).trim()) !== -1;
}

/**
 * THE RULE, generic over option shape.
 *
 * If there is a current value and nothing in `options` is marked selected,
 * append an option for it. Extracted from ro-writer.js so the service-writer
 * dropdown and the floor pickers cannot drift apart.
 *
 * @param {Array} options      already-built options, each with `.selected`
 * @param {boolean} hasCurrent is something actually assigned right now?
 * @param {Function} buildCurrent  () => option, called only when needed
 */
export function appendCurrentIfMissing(options, hasCurrent, buildCurrent) {
  const list = options || [];
  if (!hasCurrent) return list;
  if (list.some((o) => o && o.selected)) return list;
  return list.concat([buildCurrent()]);
}

/**
 * Build options for a NAME-keyed assignee dropdown (the floor tables store
 * the tech's name, not an id).
 *
 * Guarantees, and these are the point:
 *   1. EXACTLY ONE option is selected, always.
 *   2. The current assignee is present even if absent from `roster`.
 *   3. The unassigned option keeps the CALLER's value, because the floor
 *      tables disagree with each other ('' on lifts, 'Unassigned' on
 *      parking) and changing either would rewrite live data.
 *
 * Returns [{ value, label, selected }]. The caller escapes and renders.
 */
export function buildAssigneeOptions(roster, current, opts) {
  const o = opts || {};
  const unassignedValue = o.unassignedValue == null ? '' : o.unassignedValue;
  const unassignedLabel = o.unassignedLabel == null ? 'Unassigned' : o.unassignedLabel;

  const cur = String(current == null ? '' : current).trim();
  const nobody = isUnassignedValue(cur);

  const options = [{ value: unassignedValue, label: unassignedLabel, selected: nobody }];

  const seen = {};
  (roster || []).forEach((entry) => {
    const name = String((entry && entry.name != null ? entry.name : entry) || '').trim();
    if (!name || isUnassignedValue(name)) return;   // never duplicate the sentinel row
    if (seen[name]) return;                          // two same-named techs are already
    seen[name] = true;                               // indistinguishable in a name-keyed store
    options.push({ value: name, label: name, selected: !nobody && name === cur });
  });

  return appendCurrentIfMissing(options, !nobody, () => ({
    value: cur, label: cur, selected: true,
  }));
}
