# How the File Cabinet tab is wired

> Doc: `/docs/wiring/file-cabinet.md`
> Last updated: 2026-07-30 — verified vs commit `PENDING`
> Status: ✅ verified vs commit `PENDING` — built and checked this session against `shared/file-cabinet.js` and `owner-board.html`.

## 0. In one line
A read-only tab on the **owner board** that lists the wiring docs in `/docs/wiring/`
and renders their markdown — the File Cabinet the CLAUDE.md rules describe, made visible.

## 1. What it is (and isn't)
- **Read-only.** You cannot edit a doc from the board. Docs are edited by CC in the
  repo; the tab only fetches and renders them. There is no write path, no Supabase
  table, no auth — nothing here is user-scoped.
- **Owner board only.** It lives under the sidebar's **Insights** group, next to
  Feature Adoption.

## 2. Layout
- **Left:** one folder row per doc — icon, title, and a **status chip**.
- **Right:** the selected doc, markdown rendered. The **README/overview opens by
  default** (`active = 'readme'`).
- Two-column CSS grid (`.fc-wrap`, `300px 1fr`), stacks to one column ≤768px. All
  styles are namespaced `.fc-*` and injected once by the module.

## 3. The status chip — the honesty signal (NOT hardcoded)
- Each chip is **derived from the doc's own header** by `deriveStatus()`. It prefers
  the `> Status:` line, else scans the first 16 lines.
- **"verified vs [commit] `<hash>`"** → green chip "verified vs `<hash>`" (with dot).
- **"DRAFT"** or **"Needs review"** → amber chip.
- Neither found → a neutral "unverified" chip.
- So if a doc is later flipped back to DRAFT (or a new doc is added without a
  verified stamp), its chip turns amber on its own — no code change. That automatic
  honesty is the whole reason the chip isn't a hardcoded string.

## 4. Which docs it shows (the manifest)
- This is a **static Vercel deploy** — there is **no runtime directory listing**. The
  set of docs is the `DOCS` manifest at the top of `shared/file-cabinet.js`
  (`{id, file, icon, title}` per doc), in display order. **Adding a new wiring doc
  means adding a manifest row** — it will not appear otherwise.
- `/docs/wiring/` is served as static files: `.vercelignore` does not exclude `docs/`,
  the docs are git-tracked, and `vercel.json` has no rewrite over `/docs/*`, so
  `fetch('/docs/wiring/<file>.md')` returns the raw markdown.
- Internal `*.md` links inside a doc (e.g. the README index table) are rewritten to
  switch folders in-tab rather than navigate; `http(s)` links open in a new tab;
  other relative links render inert (read-only surface).

## 5. Markdown rendering
- A small self-contained renderer in the module (no external library — matches the
  app's no-CDN-for-logic convention). Handles headings, bulleted lists (with wrapped
  continuation lines + one level of nesting), tables, blockquotes, fenced + inline
  code, links, bold/italic, and horizontal rules.
- HTML is escaped but **real entities are preserved** (the docs contain a literal
  `&nbsp;`). Inline code is split out before the emphasis/link passes so code contents
  are never altered.

## Known gaps & open questions (as of 2026-07-30)
- The renderer is intentionally minimal — it covers what these docs actually use, not
  all of CommonMark (e.g. no nested blockquotes, no reference-style links, no images).
  If a doc starts using a construct it doesn't handle, extend the renderer.
- No search/filter across docs yet — fine at ~7 docs; revisit if the cabinet grows.
- Load is eager on board open (7 small fetches in parallel) rather than lazy on tab
  open. Cheap today; make it lazy if the doc set grows large.

## Where it lives in the code
- Module: `shared/file-cabinet.js` — `window.FileCabinet.init({ mountSelector })`;
  `DOCS` manifest, `deriveStatus`, `renderMarkdown`, `inline`, injected `.fc-*` CSS.
- Host: `owner-board.html` — sidebar item `data-view="filecabinet"`, the
  `#view-filecabinet` container (`#filecabinet-root`), the `<script>` include, and the
  top-level `FileCabinet.init(...)` + `VIEW_REFRESH.filecabinet` registration.
- Data: the docs themselves under `/docs/wiring/*.md` (served static).
- Design blueprint (not shipped): `docs/_design/file-cabinet-mockup.html`.

## Session change log
- 2026-07-30 — Built the tab from the mockup: `shared/file-cabinet.js` (manifest +
  markdown renderer + header-derived status chips) wired into `owner-board.html` under
  Insights. Created this doc in the same commit (Rule 2).
