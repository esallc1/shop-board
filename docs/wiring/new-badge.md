# How the "NEW" badge is wired

> Doc: `/docs/wiring/new-badge.md`
> Last updated: 2026-09-18 — verified vs commit `bca65d3` (branch
> `feat/customer-edit-transmission`, UNMERGED — on staging only). Every claim checked against
> `shared/new-badge.js`, `shared/new-badge.css`, `shared/new-badge.test.js` and
> `advisor-board.html`, and driven in a real browser on `test.*` signed in as ZZ Test Advisor.
> Status: ✅ verified (see change log). Reduced-motion confirmed as a loaded CSS rule only — the
> browser pane can't emulate the OS setting.

## 0. In one line
A small bright-green **NEW** pill you drop next to a freshly shipped control. It shows until a
date written in the markup and then hides itself — no database, no setting, nobody has to
remember to take it down.

## 1. How to use it on a future feature (the whole recipe)
1. The board must load the two shared files (the advisor board already does):
   ```html
   <link rel="stylesheet" href="shared/new-badge.css">
   <script type="module">
     import * as NewBadge from './shared/new-badge.js';
     window.NewBadge = NewBadge;
     NewBadge.startNewBadges(document);
   </script>
   ```
2. Put the pill next to the new thing, with the **first day it should be gone**:
   ```html
   <span class="cd-new" data-new-until="2026-09-26">NEW</span>
   ```
   `2026-09-26` = visible through the end of **Friday Sept 25** shop time, hidden from
   midnight ET on the 26th. A week is the usual run.
3. That's it. Markup rendered later by JS works too (a `MutationObserver` picks it up).

**Two placements — pick by what it labels:**
- **Next to TEXT** (a label, a heading): put it right after the text —
  `<label>Transmission<span class="cd-new" data-new-until="…">NEW</span></label>`.
  It draws just after the words and takes no space.
- **On a BUTTON**: wrap the button in `.cd-new-anchor` and put the pill **after** it —
  `<span class="cd-new-anchor"><button …>Edit</button><span class="cd-new" data-new-until="…">NEW</span></span>`.
  It becomes a small tag on the button's top-right corner; the button doesn't move.

Don't drop a bare pill into a **flex** row as its own item: an out-of-flow child of a flex
container is placed at the container's start, not beside its neighbour. Use one of the two
patterns above.

## 2. The rule — `isNewBadgeVisible(until, now)`
- Visible **only** when `data-new-until` is a real `YYYY-MM-DD` day (`parseUntil` rejects
  `2026-9-26`, `09/26/2026`, `2026-02-30`, blanks, garbage) **and** today is strictly before it.
- "Today" is **shop time, `America/New_York`** (`shopToday`, via `Intl.DateTimeFormat` with
  `timeZone`) — not UTC and not the device's zone. At 9pm ET the UTC date is already tomorrow;
  using UTC would hide every badge three–four hours early on its last day.
- ISO date strings compare correctly as strings, so the check is `today < until`.

## 3. Fail-safe hidden (it can never get stuck on)
- `shared/new-badge.css` hides **every** `.cd-new` (`display:none`). The script only ever adds
  `.is-on`. So: script didn't load → hidden; bad/missing date → hidden; past date → hidden.
- A page left open for days (the counter iPad) is re-checked **hourly** and on every
  `visibilitychange` back to visible, so a badge disappears at the date even without a reload.

## 4. Look, motion, and "doesn't get in the way"
- **Look:** rounded pill (`border-radius:999px`, same family as the comeback pill), solid
  **`#16a34a`** green, white 800-weight uppercase text at `0.6rem`. Deliberately not red/orange
  (problem / comeback) and not the blue `--accent` link color.
- **Motion:** `cd-new-glow` — a soft green `box-shadow` glow, **1.8s × 3 iterations**, then
  still. It runs when the badge turns on (page load). `prefers-reduced-motion: reduce` →
  `animation: none`.
- **Layout-neutral — it takes up NO space:** `.cd-new.is-on` is `position:absolute` with **no
  offsets**, so the browser draws it at its *static position* (exactly where it would have sat
  inline, just after the text) while removing it from layout. It can't wrap, push an input down,
  or widen anything, however narrow the column. In corner mode, `.cd-new-anchor` is
  `position:relative` and the pill gets `top:-9px; right:-8px`.
  > ⚠ **Why not inline?** The first version was `inline-block` with negative vertical margins.
  > At phone width the Transmission label column is **136px**, "TRANSMISSION" + pill didn't fit,
  > the pill wrapped to a second line and the input dropped **12px** — caught by measuring on
  > staging, not by the tests. Negative margins stop a pill making one line taller; they don't
  > stop it wrapping.
- It **can overhang** the edge of a narrow column (visual only — it's `pointer-events:none`).
- **Not clickable:** `pointer-events:none` + no text selection — a tap on the pill falls through
  to what's under it; it can't steal a click from the neighbouring button.

## 5. Current uses
| Where | Markup | until |
|---|---|---|
| Customer record profile card, name row — corner tag on **Edit** ([[customer-record]] §4, §4f). Rendered by `renderCustProfile`, so it is switched on by the `MutationObserver` path on every re-render | `.cd-new-anchor` > `#custEditBtn` + `.cd-new` | `2026-09-26` |
| RO "Vehicle & reference details" → **Transmission** label ([[ro-vehicle-details]]) | inside the `<label>` | `2026-09-26` |
| RO detail right column → **Job category** label ([[ro-checkin-tech]] §7) | inside the `<label>` | `2026-09-28` |

When a date passes, the markup can stay (it's inert) or be deleted in the next tidy-up.

## Known gaps & open questions (as of 2026-09-18)
- **Contrast:** white on `#16a34a` is ≈3.3:1 — bright, as asked, but under the 4.5:1 AA
  guideline for text this small. `#15803d` would pass (≈5:1) at the cost of being darker.
- Only the advisor board loads the two files so far; another board needs step 1 before its first
  badge.

## Where it lives in the code
- `shared/new-badge.js` — `SHOP_TIME_ZONE`, `shopToday`, `parseUntil`, `isNewBadgeVisible`,
  `applyNewBadges`, `startNewBadges` (hourly + visibility re-check, `MutationObserver`).
- `shared/new-badge.css` — hidden default, `.is-on` pill, `cd-new-glow`, reduced-motion.
- `shared/new-badge.test.js` — 10 tests (day before / on / after, midnight ET edge, 9pm ET vs
  UTC, EST winter, garbage dates, `applyNewBadges`, CSS guarantees).
- `advisor-board.html` — the `<link>` + module loader and the two uses.

## Session change log
- 2026-09-19 — Third use: the RO detail's **Job category** label, until `2026-09-28` (planned ship
  Mon 2026-09-21 + 7). Branch `feat/ro-job-category`, unmerged. Verified on `test.*` at `a90963f`:
  pill on (`rgb(22,163,74)`), and at 375px the select's position/height and the label height are
  identical pill on vs off.
- 2026-09-18 — Customer Edit badge moved with its button from the top strip into the profile
  card's name row (JS-rendered now, so it relies on the `MutationObserver` re-apply). Branch
  `fix/cust-edit-in-person-card`. Verified on `test.*` at `6c22499` as ZZ Test Advisor: pill on
  after first render and after each Edit-save re-render, at 1440/1100/375; layout identical pill on
  vs off.
- 2026-09-18 — **Created.** Shared NEW pill; first two uses (customer Edit, RO Transmission
  label), both until `2026-09-26`. Branch `feat/customer-edit-transmission`, unmerged.
- 2026-09-18 (later) — **Made it out-of-flow + added corner-tag mode**, after measuring on
  staging showed the inline version wrapping in the 136px Transmission label and pushing the
  input down 12px (§4). **Verified on `test.*`, signed in as ZZ Test Advisor:** both badges on,
  `rgb(22,163,74)` / white / 800 / 999px / `pointer-events:none`; glow ran 3 × 1.8s then no
  animations and no shadow; Edit button, strip, Back, Transmission label/input/box and Engine
  rects **identical to 0.1px** badge-on vs badge-off; a real click on the pill where it overlaps
  Edit opened the Edit form, and Edit + Transmission both still saved (`authenticated` PATCH).
  **Expiry**, by faking `Date.now` and firing the module's own `visibilitychange` re-check (real
  `data-new-until` untouched): Fri 9pm ET (already Sat in UTC) → on; Fri 11:59:59pm ET → on;
  Sat 00:00 ET → both off; a week later → off. Injected pills: `soon`, no attribute, `2026-02-30`
  → hidden; valid date → shown (`MutationObserver` path).
