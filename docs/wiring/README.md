# /docs/wiring — the File Cabinet

One **living doc per subsystem**: how CrisData is wired *right now*, not a changelog.
The owner board renders this folder as the **File Cabinet**.

Rules for keeping these honest live in the project `CLAUDE.md` (read-before,
update-in-place-in-the-same-commit, end-of-session cabinet pass). The short version:
**if you change how a subsystem works, rewrite its doc in the same commit — and verify
every claim against the real code before writing it.**

## Index

| Subsystem | Doc | Status |
|---|---|---|
| Comeback / warranty | [comeback-warranty.md](comeback-warranty.md) | ✅ verified vs `bea25cf` |
| Recordings / audio | [recordings-audio.md](recordings-audio.md) | ✅ verified vs `bea25cf` |
| Customer record | [customer-record.md](customer-record.md) | ✅ verified vs `bea25cf` |
| Intake wizard | [intake-wizard.md](intake-wizard.md) | ✅ verified vs `bea25cf` (partial — customer/phone steps still thin) |
| Floor tags & lanes | [floor-tags.md](floor-tags.md) | ✅ verified vs `bea25cf` (partial — full lane taxonomy still thin) |
| File Cabinet (this tab) | [file-cabinet.md](file-cabinet.md) | ✅ verified vs the commit that adds it |

_Seeded 2026-07-30 from the Jul 29 session handoff. Verified 2026-07-30 against commit `bea25cf`:
every claim re-checked against source; two docs remain partial (noted above) but contain no
unverified claims._
