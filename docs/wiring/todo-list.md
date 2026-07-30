# How the To-Do list is wired

> Doc: `/docs/wiring/todo-list.md`
> Last updated: 2026-07-30 — verified vs commit `f8386ab`
> Status: ✅ verified vs commit `f8386ab` — checked against the four boards' To-Do code, the
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
- **Set** per item via a small `<select class="todo-prio-select">` in the row's actions (shown
  for items you manage — `created_by` or `assigned_to` is you — and only while not completed).
  New to-dos default to Normal via the DB default; nothing is set at creation.
- **Write:** `setTodoPriority(id, priority)` — optimistic (update the cached row + re-render),
  then `db.from('todos').update({ priority }).eq('id', id)`; on error it reverts and re-renders,
  and it **degrades quietly** if the column isn't migrated yet (a 42703 is swallowed, no alert).
- **Color:** a left-border accent on `.todo-item` via a `todo-prio-<value>` class —
  **Immediate = red, High = amber, Normal = neutral, Low = muted** (`shared/board-shell.css`).
  The value is also shown as text in the dropdown, so the cue is **not color-only** (accessible).
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
- Styles (shared): `shared/board-shell.css` — `.todo-item`, `.todo-prio-*`, `.todo-prio-select`.
- Schema: `migrations/20260715_todos.sql` (+ `_realtime`, `_attachments`) and
  `migrations/20260730_todos_priority.sql`.

## Session change log
- 2026-07-30 — Added per-item **priority** (Immediate/High/Normal/Low, default Normal): the
  `priority` column (`20260730_todos_priority.sql`, hand-run), a dropdown + left-border color +
  Immediate-first sort in `renderTodos`, and `setTodoPriority` (direct anon UPDATE). Applied the
  identical change to all four boards; CSS added once in `board-shell.css`. Created this doc and
  flagged the four-copy duplication as debt.
