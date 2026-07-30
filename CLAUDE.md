# CrisData — CC project instructions

## File Cabinet — living wiring docs (READ THIS)

CrisData keeps **one living doc per subsystem** under `/docs/wiring/`. These are the
source of truth for *how the system is wired right now* — **not** changelogs. The
owner board renders them as the **File Cabinet**. Keeping them honest is part of your
definition of done, not an optional extra.

### The three rules

**1. Read before you change.**
Before editing a subsystem, open its wiring doc first and work from it. If the code
contradicts the doc, the code wins — fix the doc as part of your change (rule 2).

**2. Update in place, in the same commit.**
Any change that alters how a subsystem works must update the matching
`/docs/wiring/*.md` **in the same commit that changes the code**. Rewrite the
"how it works" sections to match reality — do **not** append a dated note and leave
the old text standing. Verify every claim against the actual code / schema / migration
before you write it; never carry forward a line you haven't re-checked this session.
If a subsystem you changed has no doc yet, create one from the template below.

**3. End-of-session cabinet pass.**
Before wrapping, for each subsystem touched this session: confirm its doc matches the
code, set the header's date + `verified vs commit <HEAD>`, add one line to that doc's
Session change log, and mark any doc made stale by today's work as `⚠ Needs review`
(don't guess-update it). Report a one-line list: docs updated, docs flagged.

### Never
- Never let "durable in the DB but not documented" count as done — same spirit as
  "not re-displayed isn't shipped."
- Never write a wiring claim you haven't verified against the real code this session.
  A tidy, confident, wrong doc is worse than no doc.

### Doc template
Every file under `/docs/wiring/` follows this shape:

```
# How <subsystem> is wired
<meta: doc path · last-updated date · verified vs commit <hash> · review status>

## 0. In one line — plain-language: what this subsystem is.
## 1..N. How it works — numbered sections BY CONCEPT, not by date.
## Known gaps & open questions (as of <date>)
## Where it lives in the code — the actual files, endpoints, migrations.
## Session change log — dated one-liners. The ONLY dated part.
```

### Subsystem → doc → code map (keep this current too)

| Subsystem | Doc | Main code |
|---|---|---|
| Comeback / warranty | `comeback-warranty.md` | `advisor-board.html`, `shared/comeback-chain.js` |
| Recordings / audio | `recordings-audio.md` | `api/recording-links.js`, `shared/recording-player.js`, `api/recording-assign.js` |
| Customer record | `customer-record.md` | `#view-customer` in `advisor-board.html` |
| Intake wizard | `intake-wizard.md` | `advisor-board.html` |
| Floor tags & lanes | `floor-tags.md` | `advisor-board.html` |
| Call window & Desk | `call-window-desk.md` | `advisor-board.html` (`callerCard` + `desk` IIFEs) |
| Announcement banner | `announcements.md` | `shared/announcement-banner.js`, `api/announcement.js`, advisor + owner boards |
| To-Do list | `todo-list.md` | To-Do JS duplicated in all 4 office boards; `shared/board-shell.css` |
| RO check-in / tech assign | `ro-checkin-tech.md` | `advisor-board.html` (`checkInArrived`, `assignTechCore`), `crisdata-techboard.html`, `shared/status-mirror.js` |
| Tech Board (dispatcher) | `tech-board.md` | `crisdata-techboard.html`, `my-numbers.html`, gm-board Shop Floor |
| My Numbers (tech phone tool) | `my-numbers.md` | `my-numbers.html`; consumers: `advisor-board.html`, `gm-board.html` |
| Flagged-hours / flat-rate data | `flat-rate-hours.md` | `ro_line_items`, `shopboard_*.flag_hours`, `completed_jobs`, `repair_orders.technician` |
| File Cabinet tab | `file-cabinet.md` | `shared/file-cabinet.js`, `owner-board.html` |
