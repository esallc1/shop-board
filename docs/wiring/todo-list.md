# How the To-Do list is wired

> Doc: `/docs/wiring/todo-list.md`
> Last updated: 2026-09-18 — **§3 priority LOOK rewritten** (shared filled/outlined pills + thick
> edges, the word always shown) after Kevin's "Immediate and High are hard to tell apart"
> (2026-08-06). Branch `feat/priority-look` off `main` `4e73ade`, **unmerged**; §3 + Where-it-lives
> re-checked against the code; staging pass in the change log. Rest not re-verified.
> Previously: 2026-07-30 — verified vs commit `b02116e`
> Status: ✅ verified vs commit `b02116e` — checked against the four boards' To-Do code, the
> shared `board-shell.css`, and the `todos` migrations. ⚠ See the duplication note (§1).

## 0. In one line
A personal + assignable to-do list on every office board, backed by one `todos` table, now with
a per-item **priority** (Immediate / High / Normal / Low) that color-codes and sorts the list.

## 1. ⚠ Duplication — the same code lives in FOUR boards
The To-Do feature is **not a shared module.** Its JS (`loadAndRenderTodos`, `renderTodos`,
`addTodo`, `toggleTodoComplete`, `deleteTodo`, `startEditTodo`, `setTodoPriority`, the assign
menu, attachments) is a **byte-identical copy in all four office boards**:
`owner-board.html`, `advisor-board.html`, `gm-board.html`, `bookkeeping-board.html`.
- **Only the CSS is shared** — `.todo-*` lives in `shared/board-shell.css` (one place, all boards).
- **Any To-Do change must be applied to all four copies identically** (verify with an md5 of
  each `renderTodos`). This is real tech debt: a future change should extract To-Do into a
  `shared/todo-list.js` module (like `roadmap.js` / `planner.js`). Flagged, not yet done.

## 2. Data — the `todos` table
Columns of note: `text`, `created_by` / `created_by_name`, `assigned_to` / `assigned_to_name`
(a to-do fans out to one row per assignee), `completed_at`, `attachment_*`, `created_at`, and
now **`priority`** (`immediate|high|normal|low`, NOT NULL default `'normal'`, CHECK-constrained).
Migrations: `20260715_todos.sql` (table + `for all` anon), `_todos_realtime.sql` (publication),
`20260721_todo_attachments.sql` (attachments), **`20260730_todos_priority.sql`** (priority).

**Security:** `todos` is **anon full-access** (`for all to anon using(true) with check(true)`),
by design — the boards create/complete/delete/edit to-dos directly with the anon key. So setting
priority is a **direct anon UPDATE**; **no endpoint** is needed and nothing is widened. (Contrast
`calls` / `announcements`, which are anon-read-only and need a service-role endpoint to write.)

## 3. Priority (Kevin)
- **Who can edit — the creator/assigner only.** The editable `<select class="todo-prio-select">`
  renders **only when `CURRENT_EMPLOYEE_ID === t.created_by`** (the person who created/assigned
  the to-do) and the item isn't completed. New to-dos default to Normal via the DB default;
  nothing is set at creation.
  - **Identity match:** `CURRENT_EMPLOYEE_ID` (the current user's `employees.id`, resolved from
    the session phone) vs `t.created_by` (the creator's `employees.id`, stamped by `addTodo`) —
    an **id match**, the same reliable key the "Assigned by …" tag uses. `created_by_name` is
    display-only.
  - **The receiver sees it read-only.** For everyone else (the assignee), the control is a
    non-editable pill `<span class="prio-pill prio-pill-<value>">` with the same word + look —
    they see the priority, they just can't change it.
  - **Safe fallback:** if the current user or the creator can't be determined
    (`!CURRENT_EMPLOYEE_ID` or `created_by` null / mismatched) → **read-only** (no editable
    control). In practice unknown identity renders *no* to-dos at all (`loadAndRenderTodos`
    guards `if (!CURRENT_EMPLOYEE_ID) return`), and every rendered row has the user as creator
    or assignee, so a rendered item is always either editable (creator) or a read-only pill
    (assignee).
- **Write:** `setTodoPriority(id, priority)` — **creator-guarded** (returns early unless
  `row.created_by === CURRENT_EMPLOYEE_ID`, defense-in-depth beyond hiding the control), then
  optimistic (update the cached row + re-render) → `db.from('todos').update({ priority })`; on
  error it reverts, and it **degrades quietly** if the column isn't migrated yet (42703 swallowed).
- **The look (shared with Report a change — ONE set of rules in `shared/board-shell.css`):**
  | Level | Word | Pill | Row edge |
  |---|---|---|---|
  | Immediate | **IMMEDIATE** | solid dark red `#b91c1c`, white text | thick (5px) `#b91c1c` |
  | High | **High** | white, `#b45309` outline + text | 5px `#b45309` |
  | Normal | **Normal** | none — plain grey word `#646b7e` | neutral (`--border`) |
  | Low | **Low** | small grey (`#f3f4f6` / `#4b5563`) | neutral |
  Rows carry `prio-edge prio-edge-<value>` (two classes, so it outranks any row's own
  `border-left`); words are `<span class="prio-pill prio-pill-<value>">`. The creator's dropdown
  wears the same pill (`todo-prio-select prio-pill prio-pill-<value>`; the opened list stays
  plain). **Immediate vs High differ by SHAPE** (filled vs outlined), not only hue — as lines the
  two dark colours are only ~1.3:1 apart. WCAG: white on `#b91c1c` 6.47:1, `#b45309` on white
  5.02:1, Low 6.87:1, Normal word 4.93:1 (the old `--muted` grey was 2.84:1); edges on the row bg
  `#b91c1c` 5.99:1, `#b45309` 4.65:1. **Replaced** the old
  3px `--red`/`--amber` edges + tinted tags (Immediate vs High **1.75:1**, High tag text 2.07:1,
  the two tag backgrounds 1.05:1). No ⚠ icon: the filled pill + uppercase word already carry it,
  and the dropdown can't show a pseudo-element, so an icon would appear on some rows only.
- **The word is on every OPEN row.** The priority renders in its own `.todo-prio` slot, **outside**
  the `canManage` actions block (it used to be inside it), so it no longer depends on who can
  edit or delete the row.
- **Completed rows drop the pill** (the priority no longer matters) and the whole row keeps its
  existing 65% fade (`.todo-item.completed`), edge included.
- **Sort:** `renderTodos` sorts a **copy** of `todoRows` with `todoSortByPriority` — **active
  before completed, then Immediate → Low, then newest-first**. Completed items sink to the
  bottom regardless of priority; `todoRows` itself (which feeds the nav badge) is untouched.

## 4. Load & realtime (unchanged)
`loadAndRenderTodos` selects `todos` scoped to the current employee
(`assigned_to = me OR created_by = me`) within the last `TODO_VISIBLE_DAYS`, guarded by
`if (!CURRENT_EMPLOYEE_ID) return`. A `select('*')` picks up `priority` when present (pre-migration
it's simply absent → treated as Normal). Realtime on the `todos` table re-runs the load on any change.

## Known gaps & open questions (as of 2026-07-30)
- **The four-copy duplication (§1)** is the main risk — extract to a shared module next time
  To-Do is touched substantially.
- Priority is set only after creation (per the spec) — there's no priority picker in the add bar.
- No "priority" filter/group beyond the sort; fine for the current small lists.

## Where it lives in the code
- To-Do JS (identical ×4): `owner-board.html`, `advisor-board.html`, `gm-board.html`,
  `bookkeeping-board.html` — `renderTodos` / `setTodoPriority` / `todoSortByPriority` /
  `TODO_PRIORITIES` / `TODO_PRIORITY_OPTS`.
- Styles (shared): `shared/board-shell.css` — `.todo-item`, the **shared priority look**
  `.prio-edge.prio-edge-*` (row edge) + `.prio-pill.prio-pill-*` (word/pill, also used by Report a
  change), `.todo-prio` (slot), `.todo-prio-select` (+ `.prio-pill` for the creator's dropdown).
  Static guard: `shared/priority-look.test.js` (4 tests).
- Schema: `migrations/20260715_todos.sql` (+ `_realtime`, `_attachments`) and
  `migrations/20260730_todos_priority.sql`.

## Session change log
- 2026-09-18 — **Priority look** (Kevin, 2026-08-06, "IMMEDIATE and HIGH are hard to
  distinguish"): shared filled/outlined pills + thick edges replace the thin red/amber edges; the
  word shows on every open row, including for the creator; completed rows drop the pill.
  Report a change now uses the same shared classes. +`shared/priority-look.test.js`. Kevin's
  "clear all completed" button is **not** in this change (separate follow-up). Branch
  `feat/priority-look`.
- 2026-07-30 — Added per-item **priority** (Immediate/High/Normal/Low, default Normal): the
  `priority` column (`20260730_todos_priority.sql`, hand-run), a dropdown + left-border color +
  Immediate-first sort in `renderTodos`, and `setTodoPriority` (direct anon UPDATE). Applied the
  identical change to all four boards; CSS added once in `board-shell.css`. Created this doc and
  flagged the four-copy duplication as debt.
- 2026-07-30 — **Priority edit is creator-only** (Kevin refinement): the editable dropdown shows
  only when `CURRENT_EMPLOYEE_ID === t.created_by`; the receiver (assignee) sees a read-only
  colored pill (`.todo-prio-tag`), and `setTodoPriority` is creator-guarded. Safe fallback =
  read-only. Applied identically to all four boards.
