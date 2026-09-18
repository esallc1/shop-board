# How the "NEW" badge is wired

> Doc: `/docs/wiring/new-badge.md`
> Last updated: 2026-09-18 — written from the code on branch `feat/customer-edit-transmission`
> (UNMERGED — staging only). Every claim checked against `shared/new-badge.js`,
> `shared/new-badge.css`, `shared/new-badge.test.js` and `advisor-board.html` this session.
> Status: see the change log for the in-browser pass.

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

**Placement tips.** Inside a label: put it right after the label text
(`<label>Transmission<span class="cd-new" …>NEW</span></label>`). Next to a button in a
flex row: wrap the pill and the button together (see `.cust-rec-strip-end` in
`advisor-board.html`) so the row's `justify-content` doesn't treat the pill as its own item and
move things around.

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
- **Layout-neutral:** `inline-block`, `line-height:1`, and **negative vertical margins**
  (`-4px`) so its margin box is shorter than the line it sits in — it cannot make a label or a
  row taller. It takes only its own width beside the text.
- **Not clickable:** `pointer-events:none` + no text selection — a tap on the pill falls through
  to what's under it; it can't steal a click from the neighbouring button.

## 5. Current uses
| Where | Markup | until |
|---|---|---|
| Customer record top strip, beside **Edit** ([[customer-record]] §4f) | `.cust-rec-strip-end` > `.cd-new` + `#custEditBtn` | `2026-09-26` |
| RO "Vehicle & reference details" → **Transmission** label ([[ro-vehicle-details]]) | inside the `<label>` | `2026-09-26` |

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
- `advisor-board.html` — the `<link>` + module loader, `.cust-rec-strip-end` CSS, the two uses.

## Session change log
- 2026-09-18 — **Created.** Shared NEW pill; first two uses (customer Edit, RO Transmission
  label), both until `2026-09-26`. Branch `feat/customer-edit-transmission`, unmerged.
