# vendor/ — third-party libraries, committed (no runtime CDN)

Vendored locally to keep the app CDN-free and offline-capable (same posture as the
rest of the PWA). Do not add a `<script src="cdn…">` for these — reference the
committed file.

| File | Library | Version | License | Source | Used by |
|---|---|---|---|---|---|
| `html2canvas.min.js` | html2canvas | 1.4.1 | MIT (Niklas von Hertzen) | `https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js` | `shared/report-change.js` — "Grab my board" capture + flatten-to-PNG of the annotated screenshot (Requests & Feedback, Phase 3) |

## Notes
- **`html2canvas` is lazy-loaded** by `shared/report-change.js` (injected on first
  "Grab my board" click or first flatten), so no office board pays for it on load and
  no board HTML references it directly.
- **marker.js was deliberately NOT used.** marker.js v2/v3 are commercially licensed
  ("SEE LICENSE IN LICENSE" — a paid EULA), which we won't commit into a production
  repo; v1 is MIT but old/unmaintained. The Phase 3 annotator (arrows + text bubbles +
  undo/clear) is a small self-contained SVG layer in `shared/report-change.js` instead —
  zero third-party annotation dependency. See `docs/wiring/change-requests.md` §8.
